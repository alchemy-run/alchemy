use crate::bitmap::Bitmap;
use anyhow::{Context, Result, bail};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::runtime::Handle;
use volume::{BLOCK_SIZE, Change, EXTENT_SIZE, Hash, Volume};

const BLOCKS_PER_EXTENT: u64 = EXTENT_SIZE / BLOCK_SIZE;

/// A volume head attached as a block device.
///
/// The cache file holds every block read or written since attach. A block is
/// *present* once its bytes are in the cache, and *dirty* once written and not
/// yet committed. Reads of blocks that aren't present fetch their whole extent
/// from the store. A flush commits every extent with a dirty block as one new
/// snapshot and moves the head.
pub struct Device {
    volume: Arc<Volume>,
    head: String,
    size: u64,
    runtime: Handle,
    cache: File,
    present: Bitmap,
    dirty: Bitmap,
    /// Serializes operations; holds the snapshot the cache is based on.
    base: Mutex<Hash>,
    fetches: AtomicU64,
    flushes: AtomicU64,
}

/// What `status` reports.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Status {
    pub head: String,
    pub base: Hash,
    pub size: u64,
    pub present_blocks: u64,
    pub dirty_blocks: u64,
    pub fetches: u64,
    pub flushes: u64,
}

impl Device {
    /// Attaches `head`, with a fresh cache at `cache_path`.
    pub fn open(
        volume: Arc<Volume>,
        head: &str,
        cache_path: &Path,
        runtime: Handle,
    ) -> Result<Self> {
        let base = runtime.block_on(volume.head(head))?;
        let size = runtime.block_on(volume.manifest(&base))?.size;
        let cache = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(cache_path)
            .with_context(|| format!("opening cache {}", cache_path.display()))?;
        cache.set_len(size)?; // sparse
        let blocks = size / BLOCK_SIZE;
        Ok(Self {
            volume,
            head: head.to_string(),
            size,
            runtime,
            cache,
            present: Bitmap::new(blocks),
            dirty: Bitmap::new(blocks),
            base: Mutex::new(base),
            fetches: AtomicU64::new(0),
            flushes: AtomicU64::new(0),
        })
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn head(&self) -> &str {
        &self.head
    }

    pub fn read(&self, offset: u64, len: u32) -> Result<Vec<u8>> {
        self.check(offset, len as u64)?;
        let base = self.base.lock().unwrap();
        for extent in extents(offset, len as u64) {
            self.ensure_present(&base, extent)?;
        }
        let mut bytes = vec![0; len as usize];
        self.cache.read_exact_at(&mut bytes, offset)?;
        Ok(bytes)
    }

    pub fn write(&self, offset: u64, data: &[u8]) -> Result<()> {
        self.check(offset, data.len() as u64)?;
        let base = self.base.lock().unwrap();
        let end = offset + data.len() as u64;
        // A write that covers part of a block keeps the rest of that block.
        for edge in [offset, end.saturating_sub(1)] {
            if !offset.is_multiple_of(BLOCK_SIZE) || !end.is_multiple_of(BLOCK_SIZE) {
                self.ensure_present(&base, edge / EXTENT_SIZE)?;
            }
        }
        self.cache.write_all_at(data, offset)?;
        for block in offset / BLOCK_SIZE..end.div_ceil(BLOCK_SIZE) {
            self.present.set(block);
            self.dirty.set(block);
        }
        Ok(())
    }

    /// Discards a range: it reads as zeros afterwards.
    pub fn zero(&self, offset: u64, len: u64) -> Result<()> {
        self.check(offset, len)?;
        const CHUNK: u64 = 1024 * 1024;
        let zeros = vec![0u8; CHUNK.min(len) as usize];
        let mut at = offset;
        while at < offset + len {
            let n = CHUNK.min(offset + len - at);
            self.write(at, &zeros[..n as usize])?;
            at += n;
        }
        Ok(())
    }

    /// Commits every dirty extent as one snapshot and moves the head to it.
    /// Returns the head's snapshot (unchanged when nothing was dirty).
    pub fn flush(&self) -> Result<Hash> {
        let mut base = self.base.lock().unwrap();
        let mut dirty_extents: Vec<u64> = Vec::new();
        for word in self.dirty.nonzero_words() {
            for block in word * 64..((word + 1) * 64).min(self.size / BLOCK_SIZE) {
                if self.dirty.get(block) {
                    let extent = block / BLOCKS_PER_EXTENT;
                    if dirty_extents.last() != Some(&extent) {
                        dirty_extents.push(extent);
                    }
                }
            }
        }
        if dirty_extents.is_empty() {
            return Ok(*base);
        }
        let mut changes = Vec::with_capacity(dirty_extents.len());
        for &extent in &dirty_extents {
            self.ensure_present(&base, extent)?; // fill the blocks never written
            let mut bytes = vec![0; EXTENT_SIZE as usize];
            self.cache.read_exact_at(&mut bytes, extent * EXTENT_SIZE)?;
            changes.push((extent, Change::Write(bytes)));
        }
        let next = self
            .runtime
            .block_on(self.volume.commit(&self.head, &base, changes))?;
        for extent in dirty_extents {
            for block in extent * BLOCKS_PER_EXTENT..(extent + 1) * BLOCKS_PER_EXTENT {
                self.dirty.clear(block);
            }
        }
        *base = next;
        self.flushes.fetch_add(1, Ordering::Relaxed);
        Ok(next)
    }

    /// Flushes, then creates head `to` on the flushed snapshot. The attached
    /// head keeps going; `to` can be attached anywhere.
    pub fn fork(&self, to: &str) -> Result<Hash> {
        let id = self.flush()?;
        self.runtime.block_on(self.volume.fork_at(id, to))?;
        Ok(id)
    }

    pub fn status(&self) -> Status {
        let base = *self.base.lock().unwrap();
        let blocks = self.size / BLOCK_SIZE;
        let count = |bitmap: &Bitmap| (0..blocks).filter(|&b| bitmap.get(b)).count() as u64;
        Status {
            head: self.head.clone(),
            base,
            size: self.size,
            present_blocks: count(&self.present),
            dirty_blocks: count(&self.dirty),
            fetches: self.fetches.load(Ordering::Relaxed),
            flushes: self.flushes.load(Ordering::Relaxed),
        }
    }

    /// Makes every block of `extent` present, fetching it once if needed.
    /// Dirty blocks are never overwritten: they're newer than the store.
    fn ensure_present(&self, base: &Hash, extent: u64) -> Result<()> {
        let (first, last) = (extent * BLOCKS_PER_EXTENT, (extent + 1) * BLOCKS_PER_EXTENT);
        if self.present.all(first, last) {
            return Ok(());
        }
        let stored = self
            .runtime
            .block_on(self.volume.read_extent(base, extent))?;
        self.fetches.fetch_add(1, Ordering::Relaxed);
        let zeros = [0u8; BLOCK_SIZE as usize];
        for block in first..last {
            if self.present.get(block) {
                continue;
            }
            let at = ((block - first) * BLOCK_SIZE) as usize;
            let bytes = stored
                .as_ref()
                .map_or(&zeros[..], |s| &s[at..at + BLOCK_SIZE as usize]);
            self.cache.write_all_at(bytes, block * BLOCK_SIZE)?;
            self.present.set(block);
        }
        Ok(())
    }

    fn check(&self, offset: u64, len: u64) -> Result<()> {
        if offset.checked_add(len).is_none_or(|end| end > self.size) {
            bail!(
                "{offset}+{len} is past the end of a {}-byte device",
                self.size
            );
        }
        Ok(())
    }
}

fn extents(offset: u64, len: u64) -> std::ops::Range<u64> {
    if len == 0 {
        return 0..0;
    }
    offset / EXTENT_SIZE..(offset + len).div_ceil(EXTENT_SIZE)
}
