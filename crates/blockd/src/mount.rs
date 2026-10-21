//! A volume mounted at a directory, in the best mode the host allows.
//!
//! Every mode serves the same [`Device`] and mounts its filesystem (ext4 or
//! btrfs, see [`crate::fs`]) with the kernel's own driver; they differ in how
//! blocks reach the kernel:
//!
//! - **ublk**: a kernel block device served over io_uring. The fastest.
//! - **nbd**: a kernel block device served over a socket.
//! - **loop**: the volume served as one file over FUSE, attached to a loop
//!   device, and mounted with the kernel's ext4. Needs `/dev/fuse`, a loop
//!   device and the right to mount, which Cloudflare Containers and Lambda
//!   MicroVMs allow where they allow nothing else.
//!
//! There is deliberately no userspace ext4 (`fuse2fs`): it doesn't write the
//! ext4 journal and caches writes past `fsync`, so it can't keep the promise
//! that an `fsync`ed write survives the machine.

use crate::Device;
use crate::fs::Fs;
use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

/// How the volume is attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Ublk,
    Nbd,
    Loop,
}

impl std::str::FromStr for Mode {
    type Err = anyhow::Error;
    fn from_str(text: &str) -> Result<Self> {
        Ok(match text {
            "ublk" => Mode::Ublk,
            "nbd" => Mode::Nbd,
            "loop" => Mode::Loop,
            other => bail!("unknown mode {other:?}: use auto, ublk, nbd or loop"),
        })
    }
}

impl Mode {
    /// The best mode this host allows.
    pub fn detect() -> Result<Self> {
        let root = unsafe { libc::geteuid() } == 0;
        let can_mount = root && mount_allowed();
        let fuse = cfg!(feature = "fuse") && openable("/dev/fuse");
        if can_mount && cfg!(feature = "ublk") && openable("/dev/ublk-control") {
            return Ok(Mode::Ublk);
        }
        if can_mount && openable("/dev/nbd0") {
            return Ok(Mode::Nbd);
        }
        if can_mount && fuse && loop_available() {
            return Ok(Mode::Loop);
        }
        bail!(
            "this host can't mount a volume: it needs CAP_SYS_ADMIN and a block device (ublk or \
             NBD), or /dev/fuse and a loop device"
        )
    }
}

/// A mounted volume. [`Mount::unmount`] syncs and unmounts it, and takes
/// the transport down; every write is then in the device.
pub struct Mount {
    mode: Mode,
    fs: Fs,
    dir: PathBuf,
    block: PathBuf,
    /// More mounts of the same filesystem, unmounted first.
    extra: Vec<PathBuf>,
    teardown: Box<dyn FnOnce() -> Result<()> + Send>,
}

impl Mount {
    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn fs(&self) -> Fs {
        self.fs
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Mounts a btrfs volume's top level at `dir` too, until this unmounts.
    pub fn mount_top(&mut self, dir: &Path, readonly: bool) -> Result<()> {
        crate::fs::mount_top(&self.block, dir, readonly)?;
        self.extra.push(dir.to_path_buf());
        Ok(())
    }

    pub fn unmount(self) -> Result<()> {
        for dir in self.extra.iter().rev() {
            umount(dir)?;
        }
        (self.teardown)()
    }
}

/// Mounts `device` at `dir` in `mode`. `cache` is the device's cache file;
/// FUSE modes put their disk file's mountpoint next to it.
pub fn mount(device: &Arc<Device>, mode: Mode, cache: &Path, dir: &Path) -> Result<Mount> {
    mount_as(device, mode, cache, dir, false)
}

/// [`mount`], read-only if asked: nothing is replayed or written.
pub fn mount_as(
    device: &Arc<Device>,
    mode: Mode,
    cache: &Path,
    dir: &Path,
    readonly: bool,
) -> Result<Mount> {
    std::fs::create_dir_all(dir)?;
    let fs = Fs::detect(device)?;
    if !fs.supported() {
        bail!("this machine's kernel can't mount {fs:?}");
    }
    let mount_fs = |block: &Path, dir: &Path| crate::fs::mount(fs, block, dir, readonly);
    let block: PathBuf;
    let teardown: Box<dyn FnOnce() -> Result<()> + Send> = match mode {
        #[cfg(feature = "fuse")]
        Mode::Loop => {
            let disk = crate::fuse::serve_file(device.clone(), &cache.with_extension("disk"))?;
            let loop_device = attach_loop(&disk.file())?;
            block = loop_device.clone();
            if let Err(e) = mount_fs(&loop_device, dir) {
                let _ = detach_loop(&loop_device);
                return Err(e);
            }
            let dir = dir.to_path_buf();
            Box::new(move || {
                umount(&dir)?;
                detach_loop(&loop_device)?;
                drop(disk);
                Ok(())
            })
        }
        Mode::Nbd => {
            let nbd = free_nbd()?;
            let attachment = crate::nbd::attach(&nbd, device.clone())?;
            block = nbd.clone();
            if let Err(e) = wait_until_sized(&nbd).and_then(|()| mount_fs(&nbd, dir)) {
                let _ = attachment.detach();
                return Err(e);
            }
            let dir = dir.to_path_buf();
            Box::new(move || {
                umount(&dir)?;
                attachment.detach()
            })
        }
        #[cfg(feature = "ublk")]
        Mode::Ublk => {
            let ublk = crate::ublk::Ublk::create(-1, 1)?;
            let killer = ublk.killer();
            let (ready, path) = std::sync::mpsc::channel();
            let serving = {
                let device = device.clone();
                std::thread::spawn(move || ublk.serve(device, move |path| drop(ready.send(path))))
            };
            let path = PathBuf::from(path.recv().context("the ublk device never started")?);
            block = path.clone();
            if let Err(e) = wait_until_sized(&path).and_then(|()| mount_fs(&path, dir)) {
                killer.kill();
                let _ = serving.join();
                return Err(e);
            }
            let dir = dir.to_path_buf();
            Box::new(move || {
                umount(&dir)?;
                killer.kill();
                serving
                    .join()
                    .map_err(|_| anyhow::anyhow!("the ublk server panicked"))?
            })
        }
        #[allow(unreachable_patterns)]
        other => bail!("this build of blockd doesn't support {other:?}"),
    };
    Ok(Mount {
        mode,
        fs,
        dir: dir.to_path_buf(),
        block,
        extra: Vec::new(),
        teardown,
    })
}

/// Syncs and unmounts `dir`: every write is in the device afterwards. A
/// process still using the mount when it ends (a server a command left
/// running, a shell parked in it) is killed first: the mount's lifetime is
/// the caller's, not theirs.
pub(crate) fn umount(dir: &Path) -> Result<()> {
    sync(dir);
    for attempt in 0..10 {
        let killed = kill_users(dir);
        if killed > 0 {
            tracing::info!("killed {killed} processes still using {}", dir.display());
            std::thread::sleep(std::time::Duration::from_millis(100));
            sync(dir);
        }
        let status = crate::helper("umount").arg(dir).status()?;
        if status.success() {
            return Ok(());
        }
        tracing::warn!(
            "umount {} failed ({status}), attempt {attempt}",
            dir.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    bail!("umount {} failed: still busy", dir.display())
}

/// Kills (SIGKILL) every process other than this one whose working
/// directory or any open file is under `dir`. Returns how many.
pub(crate) fn kill_users(dir: &Path) -> usize {
    users(dir)
        .into_iter()
        .filter(|user| unsafe { libc::kill(user.pid as i32, libc::SIGKILL) } == 0)
        .count()
}

/// A process using a mount.
#[derive(Clone, Debug, serde::Serialize)]
pub struct User {
    pub pid: u32,
    /// Its command line, spaces between arguments.
    pub command: String,
}

/// Every process other than this one whose working directory or any open
/// file is under `dir`.
pub fn users(dir: &Path) -> Vec<User> {
    let Ok(dir) = std::fs::canonicalize(dir) else {
        return Vec::new();
    };
    let me = std::process::id();
    let under = |link: std::io::Result<PathBuf>| link.is_ok_and(|target| target.starts_with(&dir));
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return found;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == me {
            continue;
        }
        let proc = entry.path();
        let mut uses = under(std::fs::read_link(proc.join("cwd")));
        if !uses && let Ok(fds) = std::fs::read_dir(proc.join("fd")) {
            uses = fds.flatten().any(|fd| under(std::fs::read_link(fd.path())));
        }
        // A zombie, or a process mid-exit, holds nothing.
        let exiting = std::fs::read_to_string(proc.join("stat")).is_ok_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z') || rest.starts_with('X'))
        });
        if uses && !exiting {
            let command = std::fs::read(proc.join("cmdline"))
                .map(|bytes| {
                    String::from_utf8_lossy(&bytes)
                        .split('\0')
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            found.push(User { pid, command });
        }
    }
    found
}

/// Attaches `file` to a free loop device, bypassing the page cache where
/// the kernel allows it (the FUSE file is already uncached). Busybox's
/// losetup has no `--direct-io`.
fn attach_loop(file: &Path) -> Result<PathBuf> {
    for flags in [&["-f", "--show", "--direct-io=on"][..], &["-f", "--show"]] {
        let output = Command::new("losetup")
            .args(flags)
            .arg(file)
            .output()
            .context("running losetup (install util-linux)")?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok(PathBuf::from(path));
        }
        tracing::debug!(
            "losetup {flags:?} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    bail!("no loop device for {}", file.display())
}

fn detach_loop(device: &Path) -> Result<()> {
    let status = crate::helper("losetup").arg("-d").arg(device).status()?;
    if !status.success() {
        bail!("losetup -d {} failed: {status}", device.display());
    }
    Ok(())
}

fn loop_available() -> bool {
    on_path("losetup")
        && (Path::new("/dev/loop-control").exists() || Path::new("/dev/loop0").exists())
}

/// Waits until the kernel reports the device's size: until then a mount
/// can't read the superblock.
fn wait_until_sized(device: &Path) -> Result<()> {
    let name = device
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    for _ in 0..200 {
        let size = std::fs::read_to_string(format!("/sys/block/{name}/size")).unwrap_or_default();
        if size.trim().parse::<u64>().is_ok_and(|sectors| sectors > 0) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    bail!("{} never came up", device.display())
}

pub fn sync(dir: &Path) {
    let _ = crate::helper("sync").arg("-f").arg(dir).status();
}

/// An NBD device nobody is using (its size is 0).
fn free_nbd() -> Result<PathBuf> {
    for n in 0..64 {
        let size = std::fs::read_to_string(format!("/sys/block/nbd{n}/size")).unwrap_or_default();
        if size.trim() == "0" {
            return Ok(format!("/dev/nbd{n}").into());
        }
    }
    bail!("no free NBD device")
}

fn openable(path: &str) -> bool {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok()
}

pub(crate) fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

/// Whether this process may mount (CAP_SYS_ADMIN): try a throwaway tmpfs.
fn mount_allowed() -> bool {
    let dir = std::env::temp_dir().join(format!("blockd-mount-probe-{}", std::process::id()));
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let ok = crate::helper("mount")
        .args(["-t", "tmpfs", "none"])
        .arg(&dir)
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if ok {
        let _ = crate::helper("umount").arg(&dir).status();
    }
    let _ = std::fs::remove_dir(&dir);
    ok
}
