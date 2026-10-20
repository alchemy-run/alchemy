//! A pack: many compressed extents in one immutable object, so a flush is one
//! PUT. Readers fetch a single extent by byte range, using the offsets the
//! manifest recorded; the index at the front makes a pack self-describing.
//!
//! ```text
//! "AVPK" | version: u8 | count: u32 | count × (chunk: [u8; 32], offset: u64, len: u32) | bodies
//! ```

use crate::extent::{compress, decompress};
use crate::{Error, Hash, Result};

const MAGIC: &[u8; 4] = b"AVPK";
const VERSION: u8 = 1;
const INDEX_ENTRY: usize = 32 + 8 + 4;

/// Where one chunk lives inside a pack.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackSlot {
    pub chunk: Hash,
    pub offset: u64,
    pub len: u32,
}

/// Collects compressed chunks, then seals them into a pack.
#[derive(Default)]
pub struct PackBuilder {
    bodies: Vec<(Hash, Vec<u8>)>,
}

impl PackBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.bodies.is_empty()
    }

    /// Adds a chunk (the uncompressed extent) and returns its hash. A chunk
    /// already in this pack is stored once.
    pub fn add(&mut self, extent: &[u8]) -> Result<Hash> {
        let chunk = Hash::of(extent);
        if !self.bodies.iter().any(|(id, _)| *id == chunk) {
            self.bodies.push((chunk, compress(extent)?));
        }
        Ok(chunk)
    }

    /// The pack's bytes, its id, and where each chunk landed.
    pub fn seal(self) -> Pack {
        let header = 4 + 1 + 4 + self.bodies.len() * INDEX_ENTRY;
        let total = header + self.bodies.iter().map(|(_, b)| b.len()).sum::<usize>();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend_from_slice(MAGIC);
        bytes.push(VERSION);
        bytes.extend_from_slice(&(self.bodies.len() as u32).to_le_bytes());
        let mut slots = Vec::with_capacity(self.bodies.len());
        let mut offset = header as u64;
        for (chunk, body) in &self.bodies {
            let slot = PackSlot {
                chunk: *chunk,
                offset,
                len: body.len() as u32,
            };
            bytes.extend_from_slice(&chunk.0);
            bytes.extend_from_slice(&slot.offset.to_le_bytes());
            bytes.extend_from_slice(&slot.len.to_le_bytes());
            slots.push(slot);
            offset += body.len() as u64;
        }
        for (_, body) in &self.bodies {
            bytes.extend_from_slice(body);
        }
        let id = Hash::of(&bytes);
        Pack { id, bytes, slots }
    }
}

/// A sealed pack.
pub struct Pack {
    pub id: Hash,
    pub bytes: Vec<u8>,
    pub slots: Vec<PackSlot>,
}

impl Pack {
    pub fn key(id: &Hash) -> String {
        format!("packs/{}", id.to_hex())
    }

    pub fn slot(&self, chunk: &Hash) -> Option<PackSlot> {
        self.slots.iter().copied().find(|slot| slot.chunk == *chunk)
    }

    /// Reads a pack's index (for audits and garbage collection).
    pub fn index(bytes: &[u8]) -> Result<Vec<PackSlot>> {
        let corrupt = |reason: &str| Error::Corrupt {
            key: "pack".into(),
            reason: reason.into(),
        };
        if bytes.len() < 9 || &bytes[..4] != MAGIC || bytes[4] != VERSION {
            return Err(corrupt("bad header"));
        }
        let count = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
        let end = 9 + count * INDEX_ENTRY;
        if bytes.len() < end {
            return Err(corrupt("truncated index"));
        }
        Ok((0..count)
            .map(|i| {
                let at = 9 + i * INDEX_ENTRY;
                PackSlot {
                    chunk: Hash(bytes[at..at + 32].try_into().unwrap()),
                    offset: u64::from_le_bytes(bytes[at + 32..at + 40].try_into().unwrap()),
                    len: u32::from_le_bytes(bytes[at + 40..at + 44].try_into().unwrap()),
                }
            })
            .collect())
    }
}

/// Decompresses one chunk read by range and checks it against its hash.
pub(crate) fn open_chunk(body: &[u8], chunk: &Hash, size: usize) -> Result<Vec<u8>> {
    let extent = decompress(body, size).map_err(|e| Error::Corrupt {
        key: chunk.to_hex(),
        reason: format!("decompress: {e}"),
    })?;
    if Hash::of(&extent) != *chunk {
        return Err(Error::Corrupt {
            key: chunk.to_hex(),
            reason: "hash mismatch".into(),
        });
    }
    Ok(extent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EXTENT_SIZE;

    #[test]
    fn seal_index_and_open() {
        let a = vec![7u8; EXTENT_SIZE as usize];
        let b: Vec<u8> = (0..EXTENT_SIZE).map(|i| (i % 251) as u8).collect();
        let mut builder = PackBuilder::new();
        let ha = builder.add(&a).unwrap();
        let hb = builder.add(&b).unwrap();
        assert_eq!(builder.add(&a).unwrap(), ha, "duplicates are stored once");
        let pack = builder.seal();
        assert_eq!(pack.slots.len(), 2);
        assert_eq!(Pack::index(&pack.bytes).unwrap(), pack.slots);
        for (hash, original) in [(ha, &a), (hb, &b)] {
            let slot = pack.slot(&hash).unwrap();
            let body = &pack.bytes[slot.offset as usize..(slot.offset + slot.len as u64) as usize];
            assert_eq!(
                &open_chunk(body, &hash, EXTENT_SIZE as usize).unwrap(),
                original
            );
        }
    }

    #[test]
    fn a_wrong_hash_is_corrupt() {
        let mut builder = PackBuilder::new();
        let hash = builder.add(&[1u8; 4096]).unwrap();
        let pack = builder.seal();
        let slot = pack.slot(&hash).unwrap();
        let body = &pack.bytes[slot.offset as usize..];
        let wrong = Hash::of(b"other");
        assert!(matches!(
            open_chunk(&body[..slot.len as usize], &wrong, 4096),
            Err(Error::Corrupt { .. })
        ));
    }
}
