//! One command against a volume: attach, mount at a directory, run, unmount,
//! detach. The attach mode is the best the host allows (`Mode::detect`), so a
//! sandbox can run `blockd exec` the same way on every host.

use crate::Device;
#[cfg(feature = "ublk")]
use anyhow::Context;
use anyhow::{Result, bail};
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

/// How the volume is attached for the command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Kernel ext4 on a ublk device: the fastest.
    Ublk,
    /// Kernel ext4 on an NBD device.
    Nbd,
    /// fuse2fs over the volume served as a file: no block device needed.
    Fuse,
    /// Copy out, run, write back: no mount at all.
    Copy,
}

impl std::str::FromStr for Mode {
    type Err = anyhow::Error;
    fn from_str(text: &str) -> Result<Self> {
        Ok(match text {
            "ublk" => Mode::Ublk,
            "nbd" => Mode::Nbd,
            "fuse" => Mode::Fuse,
            "copy" => Mode::Copy,
            other => bail!("unknown mode {other:?}: use auto, ublk, nbd, fuse or copy"),
        })
    }
}

impl Mode {
    /// The best mode this host allows.
    pub fn detect() -> Self {
        let root = unsafe { libc::geteuid() } == 0;
        let can_mount = root && mount_allowed();
        if can_mount && cfg!(feature = "ublk") && openable("/dev/ublk-control") {
            return Mode::Ublk;
        }
        if can_mount && openable("/dev/nbd0") {
            return Mode::Nbd;
        }
        if cfg!(feature = "fuse") && openable("/dev/fuse") && on_path("fuse2fs") {
            return Mode::Fuse;
        }
        Mode::Copy
    }
}

/// Runs `command` (with `sh -c`) in `dir` with the volume mounted there, and
/// returns its exit code. The device is left flushed; close it after.
pub fn exec(
    device: &Arc<Device>,
    mode: Mode,
    cache: &Path,
    dir: &Path,
    command: &str,
) -> Result<i32> {
    match mode {
        Mode::Copy => {
            let options = crate::copy::RunOptions {
                dir: dir.to_path_buf(),
                command: command.to_string(),
                keep: false,
            };
            Ok(crate::copy::run(device, &options)?.exit_code)
        }
        #[cfg(feature = "fuse")]
        Mode::Fuse => {
            let mounted = crate::fuse::mount(device.clone(), &cache.with_extension("disk"), dir)?;
            let code = run(command, dir);
            sync(dir);
            mounted.unmount()?;
            device.flush()?;
            code
        }
        Mode::Nbd => {
            let nbd = free_nbd()?;
            let attachment = crate::nbd::attach(&nbd, device.clone())?;
            let result = with_mount(&nbd, dir, || run(command, dir));
            attachment.detach()?;
            result
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
            let path = path.recv().context("the ublk device never started")?;
            let result = with_mount(Path::new(&path), dir, || run(command, dir));
            killer.kill();
            serving
                .join()
                .map_err(|_| anyhow::anyhow!("the ublk server panicked"))??;
            result
        }
        #[allow(unreachable_patterns)]
        other => bail!("this build of blockd doesn't support {other:?}"),
    }
}

fn run(command: &str, dir: &Path) -> Result<i32> {
    let status = Command::new("sh")
        .args(["-c", command])
        .current_dir(dir)
        .status()?;
    Ok(status.code().unwrap_or(128))
}

/// Mounts `device` at `dir`, runs `body`, and unmounts whatever happens.
fn with_mount(device: &Path, dir: &Path, body: impl FnOnce() -> Result<i32>) -> Result<i32> {
    std::fs::create_dir_all(dir)?;
    wait_until_sized(device)?;
    let status = crate::helper("mount")
        .args(["-t", "ext4"])
        .arg(device)
        .arg(dir)
        .status()?;
    if !status.success() {
        bail!(
            "mount {} {} failed: {status}",
            device.display(),
            dir.display()
        );
    }
    let result = body();
    sync(dir);
    let status = crate::helper("umount").arg(dir).status()?;
    if !status.success() {
        bail!("umount {} failed: {status}", dir.display());
    }
    result
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

fn sync(dir: &Path) {
    let _ = crate::helper("sync").arg("-f").arg(dir).status();
}

/// An NBD device nobody is using (its size is 0).
fn free_nbd() -> Result<std::path::PathBuf> {
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

fn on_path(program: &str) -> bool {
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
