//! A manifest is one snapshot of a volume: for every extent, which pack holds
//! it and where. Extents are grouped into pages of [`PAGE_ENTRIES`]; a page
//! that holds nothing is omitted, and an unchanged page is shared with the
//! parent by hash, so a commit writes only the pages it touched.
//!
//! ```text
//! manifest: "AVMF" | version | size: u64 | extent: u32 | parent: flag + [u8;32] | pages: count + count × (flag + [u8;32])
//! page:     "AVPG" | version | PAGE_ENTRIES × (flag + chunk + pack + offset: u64 + len: u32)
//! ```

use crate::{Error, Hash, Result};

/// Extents per page.
pub const PAGE_ENTRIES: usize = 1024;

const MANIFEST_MAGIC: &[u8; 4] = b"AVMF";
const PAGE_MAGIC: &[u8; 4] = b"AVPG";
const VERSION: u8 = 1;
const ENTRY_LEN: usize = 1 + 32 + 32 + 8 + 4;

/// Where one extent's bytes are stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Hash of the uncompressed extent.
    pub chunk: Hash,
    /// The pack that holds it.
    pub pack: Hash,
    /// Byte range of its compressed body inside the pack.
    pub offset: u64,
    pub len: u32,
}

/// [`PAGE_ENTRIES`] consecutive extents. `None` is an all-zero extent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub entries: Vec<Option<Entry>>,
}

impl Default for Page {
    fn default() -> Self {
        Self {
            entries: vec![None; PAGE_ENTRIES],
        }
    }
}

impl Page {
    pub fn key(id: &Hash) -> String {
        format!("pages/{}", id.to_hex())
    }

    pub fn is_empty(&self) -> bool {
        self.entries.iter().all(Option::is_none)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(5 + PAGE_ENTRIES * ENTRY_LEN);
        bytes.extend_from_slice(PAGE_MAGIC);
        bytes.push(VERSION);
        for entry in &self.entries {
            match entry {
                None => bytes.extend_from_slice(&[0u8; ENTRY_LEN]),
                Some(e) => {
                    bytes.push(1);
                    bytes.extend_from_slice(&e.chunk.0);
                    bytes.extend_from_slice(&e.pack.0);
                    bytes.extend_from_slice(&e.offset.to_le_bytes());
                    bytes.extend_from_slice(&e.len.to_le_bytes());
                }
            }
        }
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != 5 + PAGE_ENTRIES * ENTRY_LEN
            || &bytes[..4] != PAGE_MAGIC
            || bytes[4] != VERSION
        {
            return Err(corrupt("page", "bad header or length"));
        }
        let entries = bytes[5..]
            .chunks_exact(ENTRY_LEN)
            .map(|raw| match raw[0] {
                0 => Ok(None),
                1 => Ok(Some(Entry {
                    chunk: Hash(raw[1..33].try_into().unwrap()),
                    pack: Hash(raw[33..65].try_into().unwrap()),
                    offset: u64::from_le_bytes(raw[65..73].try_into().unwrap()),
                    len: u32::from_le_bytes(raw[73..77].try_into().unwrap()),
                })),
                _ => Err(corrupt("page", "bad entry flag")),
            })
            .collect::<Result<_>>()?;
        Ok(Self { entries })
    }
}

/// One snapshot of a volume.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    /// Virtual size in bytes.
    pub size: u64,
    /// Extent size in bytes.
    pub extent_size: u32,
    /// The snapshot this one was committed on top of.
    pub parent: Option<Hash>,
    /// One slot per page; `None` is a page of zero extents.
    pub pages: Vec<Option<Hash>>,
}

impl Manifest {
    pub fn key(id: &Hash) -> String {
        format!("manifests/{}", id.to_hex())
    }

    /// An empty volume of `size` bytes.
    pub fn empty(size: u64, extent_size: u32) -> Self {
        let extents = size.div_ceil(extent_size as u64);
        let pages = (extents as usize).div_ceil(PAGE_ENTRIES);
        Self {
            size,
            extent_size,
            parent: None,
            pages: vec![None; pages],
        }
    }

    pub fn extents(&self) -> u64 {
        self.size.div_ceil(self.extent_size as u64)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4 + 1 + 8 + 4 + 33 + 4 + self.pages.len() * 33);
        bytes.extend_from_slice(MANIFEST_MAGIC);
        bytes.push(VERSION);
        bytes.extend_from_slice(&self.size.to_le_bytes());
        bytes.extend_from_slice(&self.extent_size.to_le_bytes());
        push_optional(&mut bytes, self.parent);
        bytes.extend_from_slice(&(self.pages.len() as u32).to_le_bytes());
        for page in &self.pages {
            push_optional(&mut bytes, *page);
        }
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let mut at = 0;
        let mut take = |n: usize| -> Result<&[u8]> {
            let slice = bytes
                .get(at..at + n)
                .ok_or_else(|| corrupt("manifest", "truncated"))?;
            at += n;
            Ok(slice)
        };
        if take(4)? != MANIFEST_MAGIC || take(1)?[0] != VERSION {
            return Err(corrupt("manifest", "bad header"));
        }
        let size = u64::from_le_bytes(take(8)?.try_into().unwrap());
        let extent_size = u32::from_le_bytes(take(4)?.try_into().unwrap());
        let parent = read_optional(take(33)?)?;
        let count = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
        let pages = (0..count)
            .map(|_| read_optional(take(33)?))
            .collect::<Result<_>>()?;
        Ok(Self {
            size,
            extent_size,
            parent,
            pages,
        })
    }
}

fn push_optional(bytes: &mut Vec<u8>, hash: Option<Hash>) {
    match hash {
        None => bytes.extend_from_slice(&[0u8; 33]),
        Some(h) => {
            bytes.push(1);
            bytes.extend_from_slice(&h.0);
        }
    }
}

fn read_optional(raw: &[u8]) -> Result<Option<Hash>> {
    match raw[0] {
        0 => Ok(None),
        1 => Ok(Some(Hash(raw[1..33].try_into().unwrap()))),
        _ => Err(corrupt("manifest", "bad flag")),
    }
}

fn corrupt(key: &str, reason: &str) -> Error {
    Error::Corrupt {
        key: key.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_roundtrip() {
        let mut page = Page::default();
        page.entries[3] = Some(Entry {
            chunk: Hash::of(b"a"),
            pack: Hash::of(b"p"),
            offset: 9,
            len: 42,
        });
        page.entries[PAGE_ENTRIES - 1] = Some(Entry {
            chunk: Hash::of(b"b"),
            pack: Hash::of(b"q"),
            offset: u64::MAX,
            len: 1,
        });
        assert_eq!(Page::decode(&page.encode()).unwrap(), page);
        assert!(Page::default().is_empty());
    }

    #[test]
    fn manifest_roundtrip_and_sizing() {
        let mut manifest = Manifest::empty(50 * 1024 * 1024 * 1024, 256 * 1024);
        assert_eq!(manifest.extents(), 204_800);
        assert_eq!(manifest.pages.len(), 200);
        manifest.parent = Some(Hash::of(b"parent"));
        manifest.pages[7] = Some(Hash::of(b"page"));
        assert_eq!(Manifest::decode(&manifest.encode()).unwrap(), manifest);
        assert!(Manifest::decode(&manifest.encode()[..20]).is_err());
    }
}
