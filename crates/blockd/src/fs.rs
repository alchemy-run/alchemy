//! The filesystem on a volume: ext4 or btrfs, found by its superblock.
//!
//! **btrfs layout.** The workspace's files are the subvolume `data`, which is
//! the default subvolume, so a plain mount shows them. The top level holds
//! `.alchemy/`, where blockd keeps read-only snapshots it diffs against
//! (`btrfs send`): they ride along in the volume's own snapshots, cost no
//! data, and never show up in the workspace.

use crate::Device;
use anyhow::{Context, Result, bail};
use std::fs::File;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

/// A filesystem blockd mounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fs {
    Ext4,
    Btrfs,
}

/// The default subvolume a btrfs volume's files live in.
pub const DATA: &str = "data";
/// Where blockd keeps its snapshots, at a btrfs volume's top level.
pub const SNAPSHOTS: &str = ".alchemy";

impl Fs {
    /// The filesystem on `device`, from its superblock.
    pub fn detect(device: &Device) -> Result<Self> {
        if device.size() > 0x10048 {
            let magic = device.read(0x10040, 8)?;
            if magic == b"_BHRfS_M" {
                return Ok(Fs::Btrfs);
            }
        }
        let superblock = device.read(1024, 64)?;
        if u16::from_le_bytes([superblock[56], superblock[57]]) == 0xEF53 {
            return Ok(Fs::Ext4);
        }
        bail!("the volume holds neither ext4 nor btrfs")
    }

    /// Whether this kernel can mount it.
    pub fn supported(self) -> bool {
        let name = match self {
            Fs::Ext4 => "ext4",
            Fs::Btrfs => "btrfs",
        };
        std::fs::read_to_string("/proc/filesystems")
            .is_ok_and(|all| all.lines().any(|line| line.split_whitespace().last() == Some(name)))
    }
}

/// Mounts the filesystem on block device `device` at `dir`. A read-only
/// mount replays nothing: a snapshot was taken unmounted, so it's clean.
pub fn mount(fs: Fs, device: &Path, dir: &Path, readonly: bool) -> Result<()> {
    match (fs, readonly) {
        (Fs::Ext4, false) => run_mount("ext4", None, device, dir),
        (Fs::Ext4, true) => run_mount("ext4", Some("ro,noload"), device, dir),
        (Fs::Btrfs, false) => run_mount("btrfs", None, device, dir),
        (Fs::Btrfs, true) => btrfs_readonly(device, dir, ""),
    }
}

/// Mounts a btrfs volume's top level (where [`SNAPSHOTS`] lives) at `dir`.
pub fn mount_top(device: &Path, dir: &Path, readonly: bool) -> Result<()> {
    if readonly {
        btrfs_readonly(device, dir, ",subvolid=5")
    } else {
        run_mount("btrfs", Some("subvolid=5"), device, dir)
    }
}

/// btrfs read-only without replaying its log: the option's name changed
/// (`rescue=nologreplay` since Linux 5.9; plain `nologreplay` is gone).
fn btrfs_readonly(device: &Path, dir: &Path, more: &str) -> Result<()> {
    let mut last = None;
    for options in ["ro,rescue=nologreplay", "ro,nologreplay", "ro"] {
        match run_mount("btrfs", Some(&format!("{options}{more}")), device, dir) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(last.expect("tried at least once"))
}

fn run_mount(kind: &str, options: Option<&str>, device: &Path, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut command = crate::helper("mount");
    command.args(["-t", kind]);
    if let Some(options) = options {
        command.args(["-o", options]);
    }
    let status = command.arg(device).arg(dir).status()?;
    if !status.success() {
        bail!(
            "mount -t {kind} {} {} failed: {status}",
            device.display(),
            dir.display()
        );
    }
    Ok(())
}

//#region btrfs ioctls

const BTRFS_IOCTL_MAGIC: u64 = 0x94;
const BTRFS_SUBVOL_RDONLY: u64 = 1 << 1;
const BTRFS_SEND_FLAG_NO_FILE_DATA: u64 = 0x1;
const BTRFS_FIRST_FREE_OBJECTID: u64 = 256;

const fn iow(nr: u64, size: usize) -> u64 {
    (1 << 30) | ((size as u64) << 16) | (BTRFS_IOCTL_MAGIC << 8) | nr
}
const fn iowr(nr: u64, size: usize) -> u64 {
    (3 << 30) | ((size as u64) << 16) | (BTRFS_IOCTL_MAGIC << 8) | nr
}

#[repr(C)]
struct VolArgs {
    fd: i64,
    name: [u8; 4088],
}

#[repr(C)]
struct VolArgsV2 {
    fd: i64,
    transid: u64,
    flags: u64,
    unused: [u64; 4],
    name: [u8; 4040],
}

#[repr(C)]
struct SendArgs {
    send_fd: i64,
    clone_sources_count: u64,
    clone_sources: *const u64,
    parent_root: u64,
    flags: u64,
    version: u32,
    reserved: [u8; 28],
}

#[repr(C)]
struct InoLookupArgs {
    treeid: u64,
    objectid: u64,
    name: [u8; 4080],
}

const SNAP_CREATE_V2: u64 = iow(23, std::mem::size_of::<VolArgsV2>());
const SNAP_DESTROY: u64 = iow(15, std::mem::size_of::<VolArgs>());
const SEND: u64 = iow(38, std::mem::size_of::<SendArgs>());
const INO_LOOKUP: u64 = iowr(18, std::mem::size_of::<InoLookupArgs>());

fn open_dir(path: &Path) -> Result<File> {
    File::open(path).with_context(|| format!("opening {}", path.display()))
}

fn name_bytes<const N: usize>(name: &str) -> Result<[u8; N]> {
    let mut out = [0u8; N];
    if name.len() >= N || name.contains('/') || name.contains('\0') {
        bail!("bad subvolume name {name:?}");
    }
    out[..name.len()].copy_from_slice(name.as_bytes());
    Ok(out)
}

fn ioctl<T>(file: &File, request: u64, args: &mut T, what: &str) -> Result<()> {
    let ret = unsafe { libc::ioctl(file.as_raw_fd(), request as _, args as *mut T) };
    if ret < 0 {
        bail!("{what}: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

/// Snapshots subvolume `source` as `parent/name`, read-only if asked.
pub fn snapshot(source: &Path, parent: &Path, name: &str, readonly: bool) -> Result<PathBuf> {
    let source_dir = open_dir(source)?;
    let parent_dir = open_dir(parent)?;
    let mut args = VolArgsV2 {
        fd: source_dir.as_raw_fd() as i64,
        transid: 0,
        flags: if readonly { BTRFS_SUBVOL_RDONLY } else { 0 },
        unused: [0; 4],
        name: name_bytes(name)?,
    };
    ioctl(
        &parent_dir,
        SNAP_CREATE_V2,
        &mut args,
        &format!("snapshotting {} as {name}", source.display()),
    )?;
    Ok(parent.join(name))
}

/// Deletes subvolume `parent/name`, if it's there.
pub fn destroy(parent: &Path, name: &str) -> Result<()> {
    if !parent.join(name).exists() {
        return Ok(());
    }
    let parent_dir = open_dir(parent)?;
    let mut args = VolArgs {
        fd: 0,
        name: name_bytes(name)?,
    };
    ioctl(
        &parent_dir,
        SNAP_DESTROY,
        &mut args,
        &format!("deleting subvolume {name}"),
    )
}

/// The subvolume id of the subvolume whose root is `dir`.
fn subvolume_id(dir: &Path) -> Result<u64> {
    let file = open_dir(dir)?;
    let mut args = InoLookupArgs {
        treeid: 0,
        objectid: BTRFS_FIRST_FREE_OBJECTID,
        name: [0; 4080],
    };
    ioctl(&file, INO_LOOKUP, &mut args, "looking up a subvolume")?;
    Ok(args.treeid)
}

/// `btrfs send` of read-only snapshot `snapshot` against read-only snapshot
/// `parent` (version 1 of the stream). `no_data` sends where each file
/// changed instead of the bytes.
pub fn send(snapshot: &Path, parent: &Path, no_data: bool) -> Result<Vec<u8>> {
    use std::io::Read;
    let parent_root = subvolume_id(parent)?;
    let target = open_dir(snapshot)?;
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        bail!("pipe: {}", std::io::Error::last_os_error());
    }
    let (reader, writer) = unsafe {
        use std::os::fd::FromRawFd;
        (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1]))
    };
    let draining = std::thread::spawn(move || {
        let mut reader = reader;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });
    let sources = [parent_root];
    let mut args = SendArgs {
        send_fd: writer.as_raw_fd() as i64,
        clone_sources_count: 1,
        clone_sources: sources.as_ptr(),
        parent_root,
        flags: if no_data { BTRFS_SEND_FLAG_NO_FILE_DATA } else { 0 },
        version: 0,
        reserved: [0; 28],
    };
    let sent = ioctl(&target, SEND, &mut args, "btrfs send");
    drop(writer);
    let bytes = draining
        .join()
        .map_err(|_| anyhow::anyhow!("reading btrfs send panicked"))??;
    sent?;
    Ok(bytes)
}

//#endregion
