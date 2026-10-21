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
use crate::{Device, sendstream};
use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

/// What a call reports.
#[derive(Debug, serde::Serialize)]
pub struct Outcome {
    /// The command's exit code; 124 when it timed out.
    pub exit_code: i32,
    pub timed_out: bool,
    pub fs: Fs,
    /// What it changed. Its patch is written where the caller asked.
    pub summary: Summary,
    /// Processes it left running in the workspace: stopped, or kept.
    pub survivors: Vec<User>,
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

    /// Runs `command` with `sh -c` in the workspace, its output on this
    /// process's own. Returns its exit code and whether it timed out.
    pub fn run(
        &self,
        command: &str,
        cwd: Option<&Path>,
        env: &[(String, String)],
        timeout: Option<Duration>,
    ) -> Result<(i32, bool)> {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("sh");
        child
            .args(["-c", command])
            .current_dir(cwd.unwrap_or(&self.dir))
            .envs(env.iter().map(|(k, v)| (k, v)))
            .process_group(0);
        let mut child = child.spawn().context("starting the command")?;
        let pid = child.id() as i32;
        let started = std::time::Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok((status.code().unwrap_or(128), false));
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                unsafe { libc::kill(-pid, libc::SIGKILL) };
                let _ = child.wait();
                return Ok((124, true));
            }
            std::thread::sleep(Duration::from_millis(20));
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
