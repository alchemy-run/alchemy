//! The journal: blocks written since a head's last snapshot, made durable
//! by `fsync` without making a snapshot.
//!
//! Entries are named by position, `journal/{head}/{epoch}/{seq}`, and
//! written only if the name is free, so two writers can never both claim one.
//! A writer's entries are numbered from zero within its lease's epoch, with
//! no gaps, and the journal ends at the first missing position.
//!
//! ```text
//! entry: "AVJN" | version | epoch: u64 | seq: u64 | count: u32 | count × block: u64
//!        | zstd(count × BLOCK_SIZE bytes) | blake3 of everything before
//! ```

use crate::extent::{compress, decompress};
use crate::{BLOCK_SIZE, Error, Result};

const MAGIC: &[u8; 4] = b"AVJN";
const VERSION: u8 = 1;
const HEADER: usize = 4 + 1 + 8 + 8;
const CHECKSUM: usize = 32;

/// One journal entry: whole blocks, by block number. A later entry's block
/// replaces an earlier one's.
pub type Blocks = Vec<(u64, Vec<u8>)>;

pub fn key(head: &str, epoch: u64, seq: u64) -> String {
    format!("{}{seq:016x}", prefix(head, epoch))
}

pub fn prefix(head: &str, epoch: u64) -> String {
    format!("journal/{head}/{epoch:016x}/")
}

/// `(head, epoch, seq)` of a journal key.
pub fn parse_key(key: &str) -> Option<(&str, u64, u64)> {
    let rest = key.strip_prefix("journal/")?;
    let (head, rest) = rest.split_once('/')?;
    let (epoch, seq) = rest.split_once('/')?;
    Some((
        head,
        u64::from_str_radix(epoch, 16).ok()?,
        u64::from_str_radix(seq, 16).ok()?,
    ))
}

pub fn encode(blocks: &Blocks, epoch: u64, seq: u64) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(HEADER + 4 + blocks.len() * 8 + 64);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&epoch.to_le_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
    let mut data = Vec::with_capacity(blocks.len() * BLOCK_SIZE as usize);
    for (block, bytes) in blocks {
        if bytes.len() as u64 != BLOCK_SIZE {
            return Err(Error::Invalid(format!(
                "journal block {block} of {} bytes",
                bytes.len()
            )));
        }
        out.extend_from_slice(&block.to_le_bytes());
        data.extend_from_slice(bytes);
    }
    out.extend_from_slice(&compress(&data)?);
    let checksum = *blake3::hash(&out).as_bytes();
    out.extend_from_slice(&checksum);
    Ok(out)
}

/// Decodes the entry stored at `key`, checking that it names the position
/// it's stored at.
pub fn decode(key: &str, bytes: &[u8], epoch: u64, seq: u64) -> Result<Blocks> {
    let corrupt = |reason: &str| Error::Corrupt {
        key: key.into(),
        reason: reason.into(),
    };
    if bytes.len() < HEADER + 4 + CHECKSUM || &bytes[..4] != MAGIC {
        return Err(corrupt("not a journal entry"));
    }
    let (body, checksum) = bytes.split_at(bytes.len() - CHECKSUM);
    if blake3::hash(body).as_bytes() != checksum {
        return Err(corrupt("checksum mismatch"));
    }
    if body[4] != VERSION {
        return Err(corrupt("unknown version"));
    }
    let u64_at = |at: usize| u64::from_le_bytes(body[at..at + 8].try_into().unwrap());
    if u64_at(5) != epoch || u64_at(13) != seq {
        return Err(corrupt("stored at the wrong position"));
    }
    let rest = &body[HEADER..];
    let count = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
    let numbers = rest
        .get(4..4 + count * 8)
        .ok_or_else(|| corrupt("short block list"))?;
    let data = decompress(&rest[4 + count * 8..], count * BLOCK_SIZE as usize)?;
    if data.len() != count * BLOCK_SIZE as usize {
        return Err(corrupt("short block data"));
    }
    Ok(numbers
        .chunks_exact(8)
        .zip(data.chunks_exact(BLOCK_SIZE as usize))
        .map(|(n, bytes)| (u64::from_le_bytes(n.try_into().unwrap()), bytes.to_vec()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_round_trip_and_name_their_position() {
        let blocks = vec![
            (3, vec![7; BLOCK_SIZE as usize]),
            (9, vec![1; BLOCK_SIZE as usize]),
        ];
        let bytes = encode(&blocks, 2, 5).unwrap();
        assert_eq!(decode("k", &bytes, 2, 5).unwrap(), blocks);
        assert!(decode("k", &bytes, 2, 6).is_err());
    }

    #[test]
    fn a_flipped_bit_is_detected() {
        let mut bytes = encode(&vec![(0, vec![5; BLOCK_SIZE as usize])], 0, 0).unwrap();
        bytes[HEADER + 2] ^= 1;
        assert!(decode("k", &bytes, 0, 0).is_err());
    }

    #[test]
    fn keys_parse_back() {
        assert_eq!(parse_key(&key("main", 2, 10)), Some(("main", 2, 10)));
        assert_eq!(parse_key("packs/abc"), None);
    }
}
