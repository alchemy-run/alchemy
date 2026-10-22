//! One command on a fork of a snapshot, anywhere: attach the snapshot
//! ephemerally, run the command, and make a patch of what it changed.
//!
//! - **ext4:** the snapshot is mounted read-only as an overlay's lower
//!   layer, with an upper layer on this machine's disk. The upper layer is
//!   the patch's candidates.
//! - **btrfs:** the snapshot is mounted writable (its writes never leave
//!   this machine), with a read-only btrfs snapshot of the workspace taken
//!   first. `btrfs send --no-data` between the two names the candidates and
//!   the byte ranges written.
//!
//! When the command returns, processes it left running in the workspace are
//! stopped, unless the call keeps them (`keep`): then the mount stays up,
//! and [`Call::commit`] makes a patch of what changed since the last one.

use crate::fs::{self, Fs};
use crate::mount::{self, Mode, Mount, User};
use crate::patch::{self, Candidates, Summary};
use crate::container::{Container, Isolation};
use crate::timings::Timings;
use crate::{Device, sendstream};
use anyhow::{Context, Result, bail};
use tokio::runtime::Handle;
use volume::{Hash, Volume};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

/// What a call reports.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The command's exit code; 124 when it timed out.
    pub exit_code: i32,
    pub timed_out: bool,
    pub fs: Fs,
    pub snapshot: Hash,
    /// Where its patch was uploaded; `None` when it changed nothing.
    pub patch: Option<String>,
    pub summary: Summary,
    /// Processes it left running in the workspace: stopped, or kept.
    pub survivors: Vec<User>,
    pub kept: bool,
    pub timings: Timings,
}

/// Where and how a call runs.
pub struct Spec<'a> {
    pub mode: Mode,
    pub cache: &'a Path,
    pub dir: &'a Path,
    pub work: &'a Path,
    pub run: Run,
    /// The store key its patch is uploaded to.
    pub patch: Option<String>,
    /// Keep the fork mounted for processes the command leaves running.
    pub keep: bool,
    /// Run the command in a container over the fork, not on this machine.
    pub contained: Option<Contained<'a>>,
    /// The machine's chunk cache, if it has one.
    pub chunks: Option<Arc<crate::chunks::ChunkCache>>,
}

/// A call's container: how it's isolated, and where its bundle goes.
pub struct Contained<'a> {
    pub isolation: &'a Isolation,
    /// The container's id (unique on this machine).
    pub id: String,
    /// Where its bundle and scratch space go.
    pub state: &'a Path,
    /// A static blockd, the container's init.
    pub init: &'a Path,
}

/// A call whose processes are still running, its fork still mounted.
pub struct Kept {
    pub call: Call,
    pub device: Arc<Device>,
    /// Where they run, if not on this machine.
    pub container: Option<Arc<Container>>,
}

impl Kept {
    /// The processes still running.
    pub fn survivors(&self) -> Vec<User> {
        match &self.container {
            Some(container) => container.processes(),
            None => self.call.survivors(),
        }
    }

    /// Stops what's left, a last commit to `patch`, unmounts, closes.
    pub fn detach(
        mut self,
        patch: Option<&str>,
        volume: &Volume,
        runtime: &Handle,
    ) -> Result<(Summary, Option<String>, Vec<User>, Timings)> {
        let mut timings = Timings::new();
        let stopped = timings.time("stop", || match &self.container {
            Some(container) => container.stop_others(),
            None => self.call.stop_survivors(),
        });
        let made = commit_to_store(&mut self.call, patch, volume, runtime, false, &mut timings);
        if let Some(container) = self.container.take() {
            timings.time("container", || container.destroy())?;
        }
        let unmounted = timings.time("unmount", || self.call.unmount());
        timings.time("close", || self.device.close())?;
        let (summary, key) = made?;
        unmounted?;
        Ok((summary, key, stopped, timings))
    }
}

/// Runs a command on an ephemeral fork of `snapshot` and makes a patch of
/// what it changed. With `keep`, a command that leaves processes running
/// keeps its fork mounted for them: the [`Kept`] call.
pub fn call(
    volume: &Arc<Volume>,
    snapshot: Hash,
    spec: Spec,
    runtime: &Handle,
) -> Result<(Report, Option<Kept>)> {
    let mut timings = Timings::new();
    let device = Arc::new(timings.time("attach", || {
        Device::open_snapshot(volume.clone(), snapshot, spec.cache, runtime.clone())
    })?);
    if let Some(chunks) = &spec.chunks {
        device.use_chunks(chunks.clone());
    }
    let mut call = timings.time("mount", || {
        Call::mount(&device, spec.mode, spec.cache, spec.dir, spec.work)
    })?;
    let container = match &spec.contained {
        Some(contained) => {
            let started = timings.time("container", || {
                Container::start(&contained.id, contained.isolation, spec.dir, contained.state, contained.init)
            });
            match started {
                Ok(container) => Some(Arc::new(container)),
                Err(e) => {
                    let _ = call.unmount();
                    let _ = device.close();
                    return Err(e);
                }
            }
        }
        None => None,
    };
    let ran = timings.time("run", || match &container {
        Some(container) => container.exec(&spec.run),
        None => call.run(&spec.run),
    });
    let running = timings.time("settle", || match &container {
        Some(container) => container.processes(),
        None => call.survivors(),
    });
    let kept = spec.keep && ran.is_ok() && !running.is_empty();
    let survivors = if kept || running.is_empty() {
        running
    } else {
        timings.time("stop", || match &container {
            Some(container) => container.stop_others(),
            None => call.stop_survivors(),
        })
    };
    let made = ran.as_ref().map_err(|e| anyhow::anyhow!("{e:#}")).and_then(|_| {
        commit_to_store(&mut call, spec.patch.as_deref(), volume, runtime, false, &mut timings)
    });
    let fs = call.fs();
    if kept && let (Ok((code, timed_out)), Ok((summary, patch))) = (&ran, &made) {
        let report = Report {
            exit_code: *code,
            timed_out: *timed_out,
            fs,
            snapshot,
            patch: patch.clone(),
            summary: summary.clone(),
            survivors,
            kept: true,
            timings,
        };
        return Ok((report, Some(Kept { call, device, container })));
    }
    if let Some(container) = container {
        timings.time("container", || container.destroy())?;
    }
    let unmounted = timings.time("unmount", || call.unmount());
    timings.time("close", || device.close())?;
    let (exit_code, timed_out) = ran?;
    let (summary, patch) = made?;
    unmounted?;
    let report = Report {
        exit_code,
        timed_out,
        fs,
        snapshot,
        patch,
        summary,
        survivors,
        kept: false,
        timings,
    };
    Ok((report, None))
}

/// A patch from snapshot `from` to snapshot `to`, both attached read-only
/// with caches `caches` and mounted under `work`, uploaded to `key` if it
/// changes anything, and kept at `patch_file` if given.
#[allow(clippy::too_many_arguments)]
pub fn diff(
    volume: &Arc<Volume>,
    from: Hash,
    to: Hash,
    mode: Mode,
    caches: (&Path, &Path),
    work: &Path,
    key: Option<&str>,
    patch_file: Option<&Path>,
    chunks: Option<&Arc<crate::chunks::ChunkCache>>,
    runtime: &Handle,
) -> Result<serde_json::Value> {
    let mut timings = Timings::new();
    let open = |id: Hash, cache: &Path| -> Result<Arc<Device>> {
        let device = Arc::new(Device::open_snapshot(volume.clone(), id, cache, runtime.clone())?);
        if let Some(chunks) = chunks {
            device.use_chunks(chunks.clone());
        }
        Ok(device)
    };
    let (a, b) = timings.time("attach", || -> Result<_> { Ok((open(from, caches.0)?, open(to, caches.1)?)) })?;
    let (base, current) = timings.time("mount", || -> Result<_> {
        Ok((
            mount::mount_as(&a, mode, caches.0, &work.join("from"), true)?,
            mount::mount_as(&b, mode, caches.1, &work.join("to"), true)?,
        ))
    })?;
    let made = (|| -> Result<serde_json::Value> {
        let candidates = timings.time("walk", || {
            patch::walk_candidates(base.dir(), current.dir(), base.fs() == Fs::Btrfs)
        })?;
        let file_path = patch_file.map_or_else(|| work.with_extension("patch"), Path::to_path_buf);
        let mut file = std::io::BufWriter::new(std::fs::File::create(&file_path)?);
        let summary = timings.time("commit", || {
            patch::create(base.dir(), current.dir(), &candidates, Some(&mut file))
        })?;
        drop(file);
        let mut uploaded = None;
        if let Some(key) = key
            && summary.operations > 0
        {
            let bytes = std::fs::read(&file_path)?;
            timings.time("upload", || runtime.block_on(volume.blobs().put(key, bytes)))?;
            uploaded = Some(key.to_string());
        }
        if patch_file.is_none() {
            let _ = std::fs::remove_file(&file_path);
        }
        Ok(serde_json::json!({ "patch": uploaded, "summary": summary }))
    })();
    let unmounted = timings.time("unmount", || base.unmount().and(current.unmount()));
    a.close()?;
    b.close()?;
    let mut made = made?;
    unmounted?;
    made["timings"] = serde_json::to_value(&timings)?;
    Ok(made)
}

/// A patch of what `call` changed since its last commit (`full`: since the
/// fork), uploaded to `key` if it changed anything.
pub fn commit_to_store(
    call: &mut Call,
    key: Option<&str>,
    volume: &Volume,
    runtime: &Handle,
    full: bool,
    timings: &mut Timings,
) -> Result<(Summary, Option<String>)> {
    let path = call.work.with_extension("patch");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path)?);
    let summary = timings.time("commit", || call.commit(Some(&mut file), full))?;
    drop(file);
    let mut uploaded = None;
    if let Some(key) = key
        && summary.operations > 0
    {
        let bytes = std::fs::read(&path)?;
        timings.time("upload", || runtime.block_on(volume.blobs().put(key, bytes)))?;
        uploaded = Some(key.to_string());
    }
    let _ = std::fs::remove_file(&path);
    Ok((summary, uploaded))
}

/// A command to run on a fork.
#[derive(Default)]
pub struct Run {
    pub command: String,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub timeout: Option<Duration>,
    /// Where its output goes (this process's own by default).
    pub stdout: Option<std::fs::File>,
    pub stderr: Option<std::fs::File>,
    /// Drop `AWS_*` and `BLOCKD_*` from the environment it inherits.
    pub clean_env: bool,
}

/// A command's fork, mounted.
pub struct Call {
    fs: Fs,
    dir: PathBuf,
    work: PathBuf,
    mounts: Vec<Mount>,
    /// Overlay: `lower`, `upper`, and the overlay itself at `dir`.
    overlay: Option<(PathBuf, PathBuf)>,
    /// btrfs: the top level, where the base snapshot is.
    snapshots: Option<PathBuf>,
    /// A tmpfs holding the overlay's upper layer, when the disk can't.
    tmpfs: Option<PathBuf>,
    commits: u32,
    /// Overlay: the upper layer's entries at the last commit.
    committed: BTreeMap<String, Fingerprint>,
}

/// btrfs: the state at the last commit, and at the fork.
const BASE: &str = "call-base";
const FORK: &str = "call-fork";

/// What an upper layer's entry was at a commit. A directory's times move
/// with its children, so they aren't part of it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    kind: u32,
    ino: u64,
    mode: u32,
    owner: (u32, u32),
    content: Option<(u64, i64, i64, i64, i64, u64)>,
}

fn fingerprints(upper: &Path) -> Result<BTreeMap<String, Fingerprint>> {
    use std::os::unix::fs::MetadataExt;
    let mut out = BTreeMap::new();
    let mut stack = vec![upper.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let full = entry.path();
            let stat = std::fs::symlink_metadata(&full)?;
            let path = full
                .strip_prefix(upper)
                .unwrap_or(&full)
                .to_string_lossy()
                .into_owned();
            let content = (!stat.is_dir()).then(|| {
                (
                    stat.len(),
                    stat.mtime(),
                    stat.mtime_nsec(),
                    stat.ctime(),
                    stat.ctime_nsec(),
                    stat.rdev(),
                )
            });
            out.insert(
                path,
                Fingerprint {
                    kind: stat.mode() & libc::S_IFMT,
                    ino: stat.ino(),
                    mode: stat.mode(),
                    owner: (stat.uid(), stat.gid()),
                    content,
                },
            );
            if stat.is_dir() {
                stack.push(full);
            }
        }
    }
    Ok(out)
}

impl Call {
    /// Mounts `device` (an ephemeral attach) at `dir`, with scratch space in
    /// `work`.
    pub fn mount(device: &Arc<Device>, mode: Mode, cache: &Path, dir: &Path, work: &Path) -> Result<Self> {
        if !device.ephemeral() {
            bail!("a call runs on an ephemeral attach, so its writes never reach the head");
        }
        let _ = std::fs::remove_dir_all(work);
        std::fs::create_dir_all(work)?;
        let probe = Fs::detect(device)?;
        let mut call = Call {
            fs: probe,
            dir: dir.to_path_buf(),
            work: work.to_path_buf(),
            mounts: Vec::new(),
            overlay: None,
            snapshots: None,
            tmpfs: None,
            commits: 0,
            committed: BTreeMap::new(),
        };
        match probe {
            Fs::Ext4 => {
                let lower = work.join("lower");
                let mounted = mount::mount_as(device, mode, cache, &lower, true)?;
                call.mounts.push(mounted);
                std::fs::create_dir_all(dir)?;
                // The upper layer goes on this machine's disk, or on tmpfs where
                // the disk can't hold one (it's an overlay itself, in Docker).
                let mut upper = None;
                for scratch in [work.join("disk"), work.join("tmpfs")] {
                    if scratch.ends_with("tmpfs") {
                        std::fs::create_dir_all(&scratch)?;
                        let status = crate::helper("mount")
                            .args(["-t", "tmpfs", "-o", "mode=0755", "tmpfs"])
                            .arg(&scratch)
                            .status()?;
                        if !status.success() {
                            break;
                        }
                        call.tmpfs = Some(scratch.clone());
                    }
                    let layer = scratch.join("upper");
                    let workdir = scratch.join("work");
                    std::fs::create_dir_all(&layer)?;
                    std::fs::create_dir_all(&workdir)?;
                    let options = format!(
                        "lowerdir={},upperdir={},workdir={},redirect_dir=off,metacopy=off,index=off,xino=off",
                        lower.display(),
                        layer.display(),
                        workdir.display()
                    );
                    let mounted = crate::helper("mount")
                        .args(["-t", "overlay", "overlay", "-o", &options])
                        .arg(dir)
                        .stderr(std::process::Stdio::null())
                        .status()?;
                    if mounted.success() {
                        upper = Some(layer);
                        break;
                    }
                }
                let Some(upper) = upper else {
                    call.unmount()?;
                    bail!("mounting an overlay at {} failed", dir.display());
                };
                call.overlay = Some((lower, upper));
            }
            Fs::Btrfs => {
                let mut mounted = mount::mount_as(device, mode, cache, dir, false)?;
                let top = work.join("top");
                mounted.mount_top(&top, false)?;
                call.mounts.push(mounted);
                let snapshots = top.join(fs::SNAPSHOTS);
                std::fs::create_dir_all(&snapshots)?;
                fs::destroy(&snapshots, BASE)?;
                fs::destroy(&snapshots, FORK)?;
                fs::snapshot(dir, &snapshots, BASE, true)?;
                fs::snapshot(dir, &snapshots, FORK, true)?;
                call.snapshots = Some(snapshots);
            }
        }
        Ok(call)
    }

    pub fn fs(&self) -> Fs {
        self.fs
    }

    /// Where the fork is mounted.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Runs `command` with `sh -c` in the workspace, in a process group of
    /// its own. Returns its exit code and whether it timed out.
    pub fn run(&self, spec: &Run) -> Result<(i32, bool)> {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("sh");
        child
            .args(["-c", &spec.command])
            .current_dir(spec.cwd.as_deref().unwrap_or(&self.dir))
            .process_group(0);
        if spec.clean_env {
            // The daemon's environment holds the store's credentials.
            child.env_clear().envs(std::env::vars().filter(|(name, _)| {
                !name.starts_with("AWS_") && !name.starts_with("BLOCKD_")
            }));
        }
        child.envs(spec.env.iter().map(|(k, v)| (k, v)));
        if let Some(stdout) = &spec.stdout {
            child.stdout(stdout.try_clone()?);
        }
        if let Some(stderr) = &spec.stderr {
            child.stderr(stderr.try_clone()?);
        }
        if spec.stdout.is_some() || spec.stderr.is_some() {
            child.stdin(std::process::Stdio::null());
        }
        let mut child = child.spawn().context("starting the command")?;
        let pid = child.id() as i32;
        let started = std::time::Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok((status.code().unwrap_or(128), false));
            }
            if spec.timeout.is_some_and(|t| started.elapsed() >= t) {
                unsafe { libc::kill(-pid, libc::SIGKILL) };
                let _ = child.wait();
                return Ok((124, true));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Processes still using the workspace (after a moment, so a command's
    /// last forks have settled).
    pub fn survivors(&self) -> Vec<User> {
        std::thread::sleep(Duration::from_millis(50));
        mount::users(&self.dir)
            .into_iter()
            .filter(|user| !user.command.is_empty())
            .collect()
    }

    /// Stops every process still using the workspace; returns them.
    pub fn stop_survivors(&self) -> Vec<User> {
        let users = self.survivors();
        for _ in 0..10 {
            if mount::kill_users(&self.dir) == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        users
    }

    /// A patch of what changed since the last commit (`full`: since the
    /// fork), written to `out`.
    pub fn commit(&mut self, out: Option<&mut dyn std::io::Write>, full: bool) -> Result<Summary> {
        crate::mount::sync(&self.dir);
        self.commits += 1;
        match (&self.overlay, &self.snapshots) {
            (Some((lower, upper)), _) => {
                let now = fingerprints(upper)?;
                let mut candidates = patch::overlay_candidates(upper)?;
                if !full && self.commits > 1 {
                    // Only what changed since the last commit.
                    candidates
                        .paths
                        .retain(|path| self.committed.get(path) != now.get(path));
                    candidates.replaced.retain(|path| candidates.paths.contains(path));
                    for path in self.committed.keys() {
                        if !now.contains_key(path) && std::fs::symlink_metadata(lower.join(path)).is_err() {
                            candidates.paths.insert(path.clone());
                            candidates.deleted.insert(path.clone());
                        }
                    }
                }
                let summary = patch::create(lower, &self.dir, &candidates, out)?;
                self.committed = now;
                Ok(summary)
            }
            (None, Some(snapshots)) => {
                let end = format!("call-{}", self.commits);
                fs::destroy(snapshots, &end)?;
                let current = fs::snapshot(&self.dir, snapshots, &end, true)?;
                let base = snapshots.join(if full { FORK } else { BASE });
                let stream = fs::send(&current, &base, true)?;
                let touched = sendstream::parse(&stream)?;
                let candidates = Candidates {
                    paths: touched.paths,
                    ranges: touched.ranges,
                    same_inodes: true,
                    ..Default::default()
                };
                let summary = patch::create(&base, &current, &candidates, out)?;
                // The next commit is against this one.
                fs::destroy(snapshots, BASE)?;
                std::fs::rename(&current, snapshots.join(BASE))?;
                Ok(summary)
            }
            _ => bail!("a call that isn't mounted"),
        }
    }

    /// Unmounts everything; the attach's writes are forgotten at close.
    pub fn unmount(mut self) -> Result<()> {
        if self.overlay.is_some() {
            mount::umount(&self.dir)?;
        }
        for mounted in self.mounts.drain(..).rev() {
            mounted.unmount()?;
        }
        if let Some(tmpfs) = self.tmpfs.take() {
            mount::umount(&tmpfs)?;
        }
        let _ = std::fs::remove_dir_all(&self.work);
        Ok(())
    }
}
