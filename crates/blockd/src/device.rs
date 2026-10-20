use crate::bitmap::Bitmap;
use anyhow::{Context, Result, bail};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::runtime::Handle;
use volume::{BLOCK_SIZE, Change, EXTENT_SIZE, Hash, Volume};

const BLOCKS_PER_EXTENT: u64 = EXTENT_SIZE / BLOCK_SIZE;
const STATE_MAGIC: &[u8; 8] = b"BLKDCS01";

/// A volume head attached as a block device.
///
/// The cache file holds every block read or written since attach. A block is
/// *present* once its bytes are in the cache, and *dirty* once written and not
/// yet committed. Reads of blocks that aren't present fetch their whole extent
/// from the store. A flush commits every extent with a dirty block as one new
/// snapshot and moves the head; it uploads without blocking reads and writes.
///
/// A clean [`Device::close`] leaves the cache reusable: the next attach of any
/// head keeps every cached extent that its snapshot shares with the cache's.
pub struct Device {
    volume: Arc<Volume>,
    head: String,
    size: u64,
    runtime: Handle,
    cache_path: PathBuf,
    cache: File,
    present: Bitmap,
    dirty: Bitmap,
    /// Serializes block operations; holds the snapshot the cache is based on.
    base: Mutex<Hash>,
    /// One flush at a time.
    flushing: Mutex<()>,
    fetches: AtomicU64,
    flushes: AtomicU64,
    reused_blocks: u64,
}

/// What `status` reports.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Status {
    pub head: String,
    pub base: Hash,
    pub size: u64,
    pub present_blocks: u64,
    pub dirty_blocks: u64,
    /// Blocks reused from a previous attach's cache.
    pub reused_blocks: u64,
    pub fetches: u64,
    pub flushes: u64,
}

impl Device {
    /// Attaches `head` with its cache at `cache_path`, reusing what a previous
    /// clean [`Device::close`] left there.
    pub fn open(
        volume: Arc<Volume>,
        head: &str,
        cache_path: &Path,
        runtime: Handle,
    ) -> Result<Self> {
        let base = runtime.block_on(volume.head(head))?;
        let size = runtime.block_on(volume.manifest(&base))?.size;
        let blocks = size / BLOCK_SIZE;
        let state_path = state_path(cache_path);
        let saved = load_state(&state_path, size, blocks);
        // In use from here on: a crash leaves no state, so the next attach starts fresh.
        let _ = std::fs::remove_file(&state_path);

        let reused = match saved {
            Some((cached, present)) if cache_matches(cache_path, size) => {
                match runtime.block_on(volume.diff(&cached, &base)) {
                    Ok(changed) => {
                        for extent in changed {
                            for block in
                                extent * BLOCKS_PER_EXTENT..(extent + 1) * BLOCKS_PER_EXTENT
                            {
                                present.clear(block);
                            }
                        }
                        Some(present)
                    }
                    Err(e) => {
                        tracing::warn!("cache of {cached} can't be reused for {base}: {e}");
                        None
                    }
                }
            }
            _ => None,
        };
        let cache = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(reused.is_none())
            .open(cache_path)
            .with_context(|| format!("opening cache {}", cache_path.display()))?;
        cache.set_len(size)?; // sparse
        let present = reused.unwrap_or_else(|| Bitmap::new(blocks));
        let reused_blocks = present.count();
        Ok(Self {
            volume,
            head: head.to_string(),
            size,
            runtime,
            cache_path: cache_path.to_path_buf(),
            cache,
            present,
            dirty: Bitmap::new(blocks),
            base: Mutex::new(base),
            flushing: Mutex::new(()),
            fetches: AtomicU64::new(0),
            flushes: AtomicU64::new(0),
            reused_blocks,
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
        if !offset.is_multiple_of(BLOCK_SIZE) {
            self.ensure_present(&base, offset / EXTENT_SIZE)?;
        }
        if !end.is_multiple_of(BLOCK_SIZE) {
            self.ensure_present(&base, (end - 1) / EXTENT_SIZE)?;
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

    /// Commits every extent dirty right now as one snapshot and moves the head
    /// to it; returns the head's snapshot (unchanged when nothing was dirty).
    ///
    /// The dirty extents are copied out under the lock, so every write that
    /// finished before the call is in the snapshot; the upload then runs
    /// without blocking reads and writes. A failed upload leaves them dirty.
    pub fn flush(&self) -> Result<Hash> {
        let _one = self.flushing.lock().unwrap();
        let (base, extents, changes) = {
            let base = self.base.lock().unwrap();
            let extents = self.dirty_extents();
            if extents.is_empty() {
                return Ok(*base);
            }
            let mut changes = Vec::with_capacity(extents.len());
            for &extent in &extents {
                self.ensure_present(&base, extent)?; // fill the blocks never written
                let mut bytes = vec![0; EXTENT_SIZE as usize];
                self.cache.read_exact_at(&mut bytes, extent * EXTENT_SIZE)?;
                for block in extent * BLOCKS_PER_EXTENT..(extent + 1) * BLOCKS_PER_EXTENT {
                    self.dirty.clear(block);
                }
                changes.push((extent, Change::Write(bytes)));
            }
            (*base, extents, changes)
        };
        match self
            .runtime
            .block_on(self.volume.commit(&self.head, &base, changes))
        {
            Ok(next) => {
                *self.base.lock().unwrap() = next;
                self.flushes.fetch_add(1, Ordering::Relaxed);
                Ok(next)
            }
            Err(e) => {
                for extent in extents {
                    for block in extent * BLOCKS_PER_EXTENT..(extent + 1) * BLOCKS_PER_EXTENT {
                        self.dirty.set(block);
                    }
                }
                Err(e.into())
            }
        }
    }

    /// Flushes, then creates head `to` on the flushed snapshot. The attached
    /// head keeps going; `to` can be attached anywhere.
    pub fn fork(&self, to: &str) -> Result<Hash> {
        let id = self.flush()?;
        self.runtime.block_on(self.volume.fork_at(id, to))?;
        Ok(id)
    }

    /// Flushes and saves what the cache holds, so the next attach on this
    /// cache file reuses it. Returns the head's final snapshot.
    pub fn close(&self) -> Result<Hash> {
        let id = self.flush()?;
        let _base = self.base.lock().unwrap(); // no operation in flight
        if self.dirty.count() > 0 {
            bail!("writes arrived while closing");
        }
        self.cache.sync_all()?;
        save_state(&state_path(&self.cache_path), &id, self.size, &self.present)?;
        Ok(id)
    }

    /// Flushes every `every` until the device is dropped or the handle stops.
    pub fn start_flusher(self: &Arc<Self>, every: Duration) -> Flusher {
        let stop = Arc::new(AtomicBool::new(false));
        let device: Weak<Self> = Arc::downgrade(self);
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("blockd-flusher".into())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    std::thread::park_timeout(every);
                    if flag.load(Ordering::Acquire) {
                        break;
                    }
                    let Some(device) = device.upgrade() else {
                        break;
                    };
                    if let Err(e) = device.flush() {
                        tracing::warn!("background flush failed (will retry): {e:#}");
                    }
                }
            })
            .expect("spawning the flusher");
        Flusher {
            stop,
            thread: Some(thread),
        }
    }

    pub fn status(&self) -> Status {
        let base = *self.base.lock().unwrap();
        Status {
            head: self.head.clone(),
            base,
            size: self.size,
            present_blocks: self.present.count(),
            dirty_blocks: self.dirty.count(),
            reused_blocks: self.reused_blocks,
            fetches: self.fetches.load(Ordering::Relaxed),
            flushes: self.flushes.load(Ordering::Relaxed),
        }
    }

    fn dirty_extents(&self) -> Vec<u64> {
        let mut extents: Vec<u64> = Vec::new();
        for word in self.dirty.nonzero_words() {
            for block in word * 64..((word + 1) * 64).min(self.size / BLOCK_SIZE) {
                if self.dirty.get(block) {
                    let extent = block / BLOCKS_PER_EXTENT;
                    if extents.last() != Some(&extent) {
                        extents.push(extent);
                    }
                }
            }
        }
        extents
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

/// Stops a background flusher when dropped.
pub struct Flusher {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Flusher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

fn extents(offset: u64, len: u64) -> std::ops::Range<u64> {
    if len == 0 {
        return 0..0;
    }
    offset / EXTENT_SIZE..(offset + len).div_ceil(EXTENT_SIZE)
}

fn state_path(cache: &Path) -> PathBuf {
    let mut name = cache.file_name().unwrap_or_default().to_os_string();
    name.push(".state");
    cache.with_file_name(name)
}

fn cache_matches(cache: &Path, size: u64) -> bool {
    std::fs::metadata(cache).is_ok_and(|m| m.len() == size)
}

/// `magic | snapshot: [u8; 32] | size: u64 | present bitmap`
fn save_state(path: &Path, base: &Hash, size: u64, present: &Bitmap) -> Result<()> {
    let mut bytes = Vec::with_capacity(48 + present.byte_len());
    bytes.extend_from_slice(STATE_MAGIC);
    bytes.extend_from_slice(&base.0);
    bytes.extend_from_slice(&size.to_le_bytes());
    present.write_to(&mut bytes);
    let tmp = path.with_extension("state.tmp");
    std::fs::write(&tmp, &bytes)?;
    File::open(&tmp)?.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn load_state(path: &Path, size: u64, blocks: u64) -> Option<(Hash, Bitmap)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 48 || &bytes[..8] != STATE_MAGIC {
        return None;
    }
    let base = Hash(bytes[8..40].try_into().ok()?);
    let saved_size = u64::from_le_bytes(bytes[40..48].try_into().ok()?);
    if saved_size != size {
        return None;
    }
    Bitmap::read_from(&bytes[48..], blocks).map(|present| (base, present))
}
