//! A head mounted read-write under its lease: its flusher, its change
//! tracking, and the patches applied to it. `blockd mount` serves one on a
//! control socket; the daemon keeps many.

use crate::fs::Fs;
use crate::mount::{self, Mode, Mount};
use crate::timings::Timings;
use crate::track::Tracker;
use crate::{Device, Flusher};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Handle;
use volume::{Hash, Volume};

pub struct HeadOptions<'a> {
    pub mode: Mode,
    pub cache: &'a Path,
    pub dir: &'a Path,
    /// Seconds between background syncs; 0 for none.
    pub flush_every: u64,
    pub prefetch: bool,
}

pub struct Head {
    name: String,
    device: Arc<Device>,
    mounted: Option<Mount>,
    tracker: Tracker,
    volume: Arc<Volume>,
    dir: PathBuf,
    mode: Mode,
    flusher: Option<Flusher>,
    runtime: Handle,
}

/// What a mount reports when it's ready.
#[derive(serde::Serialize)]
pub struct Mounted {
    pub mounted: PathBuf,
    pub mode: Mode,
    pub head: String,
    pub fs: Fs,
    pub snapshot: Hash,
    pub epoch: u64,
    pub timings: Timings,
}

impl Head {
    /// Takes `head`'s lease, attaches it, mounts it at `dir`, and starts
    /// tracking what changes there.
    pub fn mount(
        volume: Arc<Volume>,
        head: &str,
        options: HeadOptions,
        runtime: Handle,
    ) -> Result<(Self, Mounted)> {
        let mut timings = Timings::new();
        let device = Arc::new(timings.time("attach", || {
            Device::open(volume.clone(), head, options.cache, runtime.clone())
        })?);
        let flusher = (options.flush_every > 0)
            .then(|| device.start_flusher(Duration::from_secs(options.flush_every)));
        if options.prefetch {
            let device = device.clone();
            std::thread::spawn(move || match device.prefetch(16) {
                Ok(n) => tracing::info!("prefetched {n} extents"),
                Err(e) => tracing::warn!("prefetch stopped: {e:#}"),
            });
        }
        let mut mounted = timings.time("mount", || {
            mount::mount(&device, options.mode, options.cache, options.dir)
        })?;
        let fs = mounted.fs();
        let top = options.cache.with_extension("top");
        if fs == Fs::Btrfs {
            mounted.mount_top(&top, false)?;
        }
        let tracker = timings.time("track", || {
            Tracker::start(fs, options.dir, (fs == Fs::Btrfs).then_some(top.as_path()))
        });
        let status = device.status();
        tracing::info!(
            "mounted {head} at {} in {:?} mode ({fs:?})",
            options.dir.display(),
            options.mode
        );
        let ready = Mounted {
            mounted: options.dir.to_path_buf(),
            mode: options.mode,
            head: head.to_string(),
            fs,
            snapshot: status.base,
            epoch: status.epoch,
            timings,
        };
        Ok((
            Self {
                name: head.to_string(),
                device,
                mounted: Some(mounted),
                tracker,
                volume,
                dir: options.dir.to_path_buf(),
                mode: options.mode,
                flusher,
                runtime,
            },
            ready,
        ))
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn device(&self) -> &Arc<Device> {
        &self.device
    }

    /// The paths changed here since the last checkpoint (`None`: unknown).
    pub fn checkpoint(&mut self) -> Result<Option<Vec<String>>> {
        self.tracker.checkpoint()
    }

    /// Takes a checkpoint, then applies `patches` from the store in order.
    /// Returns the checkpoint's paths, each patch's summary, and timings.
    pub fn apply(&mut self, patches: &[String]) -> Result<serde_json::Value> {
        let mut timings = Timings::new();
        let paths = timings.time("checkpoint", || self.tracker.checkpoint())?;
        let mut applied = Vec::new();
        for key in patches {
            let bytes = timings
                .time("fetch", || self.runtime.block_on(self.volume.blobs().get(key)))
                .with_context(|| format!("reading patch {key}"))?;
            let summary = timings
                .time("apply", || crate::patch::apply(&mut bytes.as_slice(), &self.dir))
                .with_context(|| format!("applying patch {key}"))?;
            applied.push(summary);
        }
        timings.time("sync", || mount::sync(&self.dir));
        self.tracker.reset()?;
        Ok(serde_json::json!({ "paths": paths, "applied": applied, "timings": timings }))
    }

    /// The last checkpoint, then unmounts so every write is in the device.
    /// Returns the checkpoint's paths. The device still needs a snapshot and
    /// [`Head::close`].
    pub fn unmount(&mut self) -> Result<Option<Vec<String>>> {
        let paths = self.tracker.checkpoint().unwrap_or_else(|e| {
            tracing::warn!("the last checkpoint failed: {e:#}");
            None
        });
        self.tracker.stop();
        if let Some(mounted) = self.mounted.take() {
            mounted.unmount()?;
        }
        Ok(paths)
    }

    /// Unmounts, snapshots, releases the lease. Returns the final snapshot
    /// and what changed since the last checkpoint.
    pub fn detach(mut self) -> Result<(Hash, Option<Vec<String>>, Timings)> {
        let mut timings = Timings::new();
        let paths = timings.time("unmount", || self.unmount())?;
        self.flusher.take();
        let snapshot = timings.time("close", || self.device.close())?;
        tracing::info!("detached {} at snapshot {snapshot}", self.name);
        Ok((snapshot, paths, timings))
    }
}
