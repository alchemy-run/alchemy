//! One cache of extents per machine, by content: every manifest entry
//! names its chunk's hash, so an extent any device on this machine fetched
//! once (an image, a session's base, a fork's snapshot) is read from local
//! disk by every other device that needs the same bytes.
//!
//! Each chunk is a file under the cache's directory, named by its hash. The
//! cache keeps itself under a size: past it, the least recently used chunks
//! go.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use volume::Hash;

pub struct ChunkCache {
    dir: PathBuf,
    limit: u64,
    /// Bytes written since the last sweep: a sweep runs every so often, not
    /// on every insert.
    since_sweep: AtomicU64,
    sweeping: Mutex<()>,
    hits: AtomicU64,
    misses: AtomicU64,
}

/// What `status` reports.
#[derive(serde::Serialize)]
pub struct ChunkStats {
    pub hits: u64,
    pub misses: u64,
}

impl ChunkCache {
    pub fn new(dir: PathBuf, limit: u64) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            limit,
            since_sweep: AtomicU64::new(0),
            sweeping: Mutex::new(()),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        })
    }

    fn path(&self, hash: &Hash) -> PathBuf {
        let hex = hash.to_hex();
        self.dir.join(&hex[..2]).join(hex)
    }

    /// The chunk's bytes, if this machine has them. A hit marks it used.
    pub fn get(&self, hash: &Hash) -> Option<Vec<u8>> {
        let path = self.path(hash);
        match std::fs::read(&path) {
            Ok(bytes) if Hash::of(&bytes) == *hash => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                // Used now: the sweep goes by modification time.
                let _ = std::fs::File::options()
                    .write(true)
                    .open(&path)
                    .and_then(|file| file.set_modified(std::time::SystemTime::now()));
                Some(bytes)
            }
            Ok(_) => {
                // Torn or corrupt: fetch it again.
                let _ = std::fs::remove_file(&path);
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(_) => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// Keeps a chunk fetched from the store (written whole, then renamed).
    pub fn put(&self, hash: &Hash, bytes: &[u8]) {
        let path = self.path(hash);
        if path.exists() {
            return;
        }
        let Some(parent) = path.parent() else { return };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
        let written = self.since_sweep.fetch_add(bytes.len() as u64, Ordering::AcqRel) + bytes.len() as u64;
        if written > self.limit / 20 {
            self.since_sweep.store(0, Ordering::Release);
            self.sweep();
        }
    }

    /// Deletes the least recently used chunks until the cache is under its limit.
    fn sweep(&self) {
        let Ok(_held) = self.sweeping.try_lock() else { return };
        let mut chunks: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
        for shard in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            for entry in std::fs::read_dir(shard.path()).into_iter().flatten().flatten() {
                if let Ok(meta) = entry.metadata() {
                    let used = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                    chunks.push((used, meta.len(), entry.path()));
                }
            }
        }
        let mut total: u64 = chunks.iter().map(|(_, len, _)| len).sum();
        if total <= self.limit {
            return;
        }
        chunks.sort_by_key(|(used, _, _)| *used);
        for (_, len, path) in chunks {
            if total <= self.limit * 9 / 10 {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    }

    pub fn stats(&self) -> ChunkStats {
        ChunkStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
        }
    }
}
