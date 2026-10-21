//! Reads a `btrfs send` stream (version 1) for what it touched: every path
//! a command names, and the byte ranges written to each file.
//!
//! The stream is a recipe for rebuilding one snapshot from another, and it
//! names files as they are mid-recipe: new files get temporary names
//! (`o259-9-0`) and are renamed later. So it's read only for *candidates*;
//! the patch compares each candidate's two snapshots to see what actually
//! changed (see [`crate::patch`]).

use anyhow::{Result, bail};
use std::collections::{BTreeMap, BTreeSet};

/// What a stream touched.
#[derive(Debug, Default)]
pub struct Touched {
    /// Every path a command names, relative to the subvolume's root.
    pub paths: BTreeSet<String>,
    /// Byte ranges written (or cloned into, or reported by `update_extent`)
    /// per path, as the stream names it.
    pub ranges: BTreeMap<String, Vec<(u64, u64)>>,
}

const CMD_WRITE: u16 = 15;
const CMD_CLONE: u16 = 16;
const CMD_TRUNCATE: u16 = 17;
const CMD_END: u16 = 21;
const CMD_UPDATE_EXTENT: u16 = 22;

const ATTR_SIZE: u16 = 4;
const ATTR_PATH: u16 = 15;
const ATTR_PATH_TO: u16 = 16;
const ATTR_PATH_LINK: u16 = 17;
const ATTR_FILE_OFFSET: u16 = 18;
const ATTR_DATA: u16 = 19;
const ATTR_CLONE_LEN: u16 = 24;

/// Parses `stream`.
pub fn parse(stream: &[u8]) -> Result<Touched> {
    const MAGIC: &[u8] = b"btrfs-stream\0";
    if !stream.starts_with(MAGIC) || stream.len() < MAGIC.len() + 4 {
        bail!("not a btrfs send stream");
    }
    let version = u32::from_le_bytes(stream[MAGIC.len()..MAGIC.len() + 4].try_into()?);
    if version != 1 {
        bail!("btrfs send stream version {version}: only version 1 is read");
    }
    let mut at = MAGIC.len() + 4;
    let mut touched = Touched::default();
    while at + 10 <= stream.len() {
        let len = u32::from_le_bytes(stream[at..at + 4].try_into()?) as usize;
        let cmd = u16::from_le_bytes(stream[at + 4..at + 6].try_into()?);
        let body_start = at + 10;
        let body_end = body_start + len;
        if body_end > stream.len() {
            bail!("a btrfs send command runs past the end of the stream");
        }
        let attrs = attributes(&stream[body_start..body_end])?;
        at = body_end;
        if cmd == CMD_END {
            break;
        }
        let path = attrs.get(&ATTR_PATH).map(|bytes| text(bytes));
        for key in [ATTR_PATH, ATTR_PATH_TO, ATTR_PATH_LINK] {
            if let Some(bytes) = attrs.get(&key) {
                touched.paths.insert(text(bytes));
            }
        }
        let Some(path) = path else { continue };
        let number = |key| attrs.get(&key).map(|bytes| u64_of(bytes)).transpose();
        match cmd {
            CMD_WRITE => {
                let offset = number(ATTR_FILE_OFFSET)?.unwrap_or(0);
                let len = attrs.get(&ATTR_DATA).map_or(0, |data| data.len() as u64);
                touched.ranges.entry(path).or_default().push((offset, len));
            }
            CMD_CLONE => {
                let offset = number(ATTR_FILE_OFFSET)?.unwrap_or(0);
                let len = number(ATTR_CLONE_LEN)?.unwrap_or(0);
                touched.ranges.entry(path).or_default().push((offset, len));
            }
            CMD_UPDATE_EXTENT => {
                let offset = number(ATTR_FILE_OFFSET)?.unwrap_or(0);
                let len = number(ATTR_SIZE)?.unwrap_or(0);
                touched.ranges.entry(path).or_default().push((offset, len));
            }
            CMD_TRUNCATE => {
                // The new size is read from the snapshot; this only marks the file.
                touched.ranges.entry(path).or_default();
            }
            _ => {}
        }
    }
    Ok(touched)
}

fn attributes(mut body: &[u8]) -> Result<BTreeMap<u16, &[u8]>> {
    let mut attrs = BTreeMap::new();
    while !body.is_empty() {
        if body.len() < 4 {
            bail!("a truncated btrfs send attribute");
        }
        let kind = u16::from_le_bytes([body[0], body[1]]);
        let len = u16::from_le_bytes([body[2], body[3]]) as usize;
        if body.len() < 4 + len {
            bail!("a btrfs send attribute runs past its command");
        }
        attrs.insert(kind, &body[4..4 + len]);
        body = &body[4 + len..];
    }
    Ok(attrs)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn u64_of(bytes: &[u8]) -> Result<u64> {
    Ok(u64::from_le_bytes(bytes.try_into().map_err(|_| {
        anyhow::anyhow!("a btrfs send number of {} bytes", bytes.len())
    })?))
}
