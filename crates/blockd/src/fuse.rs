//! The volume served as one file, `disk`, in a tiny FUSE filesystem, for
//! loop mode: the file is attached to a loop device and mounted with the
//! kernel's ext4. An `fsync` on the file is a [`Device::sync`].

use crate::Device;
use anyhow::{Context, Result};
use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo,
    LockOwner, MountOption, OpenFlags, ReplyAttr, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyWrite, Request, WriteFlags,
};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const DISK: INodeNo = INodeNo(2);
const NAME: &str = "disk";
const TTL: Duration = Duration::from_secs(3600);

struct DiskFs {
    device: Arc<Device>,
    uid: u32,
    gid: u32,
    started: SystemTime,
}

impl DiskFs {
    fn attr(&self, ino: INodeNo) -> FileAttr {
        let (kind, perm, size, nlink) = if ino == INodeNo::ROOT {
            (FileType::Directory, 0o755, 0, 2)
        } else {
            (FileType::RegularFile, 0o600, self.device.size(), 1)
        };
        FileAttr {
            ino,
            size,
            blocks: size.div_ceil(512),
            atime: self.started,
            mtime: self.started,
            ctime: self.started,
            crtime: self.started,
            kind,
            perm,
            nlink,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: volume::BLOCK_SIZE as u32,
            flags: 0,
        }
    }
}

impl Filesystem for DiskFs {
    fn lookup(&self, _: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        if parent == INodeNo::ROOT && name == NAME {
            reply.entry(&TTL, &self.attr(DISK), Generation(0));
        } else {
            reply.error(Errno::ENOENT);
        }
    }

    fn getattr(&self, _: &Request, ino: INodeNo, _: Option<FileHandle>, reply: ReplyAttr) {
        if ino == INodeNo::ROOT || ino == DISK {
            reply.attr(&TTL, &self.attr(ino));
        } else {
            reply.error(Errno::ENOENT);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn setattr(
        &self,
        _: &Request,
        ino: INodeNo,
        _: Option<u32>,
        _: Option<u32>,
        _: Option<u32>,
        _: Option<u64>,
        _: Option<fuser::TimeOrNow>,
        _: Option<fuser::TimeOrNow>,
        _: Option<SystemTime>,
        _: Option<FileHandle>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        // The disk's size and metadata are fixed; report them unchanged.
        reply.attr(&TTL, &self.attr(ino));
    }

    fn open(&self, _: &Request, ino: INodeNo, _: OpenFlags, reply: ReplyOpen) {
        if ino != DISK {
            return reply.error(Errno::EISDIR);
        }
        // Direct I/O: the kernel doesn't cache the disk's pages a second time.
        reply.opened(FileHandle(0), FopenFlags::FOPEN_DIRECT_IO);
    }

    #[allow(clippy::too_many_arguments)]
    fn read(
        &self,
        _: &Request,
        _: INodeNo,
        _: FileHandle,
        offset: u64,
        size: u32,
        _: OpenFlags,
        _: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let size = size.min(self.device.size().saturating_sub(offset) as u32);
        match self.device.read(offset, size) {
            Ok(bytes) => reply.data(&bytes),
            Err(e) => {
                tracing::error!("fuse read at {offset}+{size}: {e:#}");
                reply.error(Errno::EIO);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        _: &Request,
        _: INodeNo,
        _: FileHandle,
        offset: u64,
        data: &[u8],
        _: WriteFlags,
        _: OpenFlags,
        _: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        match self.device.write(offset, data) {
            Ok(()) => reply.written(data.len() as u32),
            Err(e) => {
                tracing::error!("fuse write at {offset}+{}: {e:#}", data.len());
                reply.error(Errno::EIO);
            }
        }
    }

    fn fsync(&self, _: &Request, _: INodeNo, _: FileHandle, _: bool, reply: ReplyEmpty) {
        match self.device.sync() {
            Ok(()) => reply.ok(),
            Err(e) => {
                tracing::error!("fuse fsync: {e:#}");
                reply.error(Errno::EIO);
            }
        }
    }

    fn flush(&self, _: &Request, _: INodeNo, _: FileHandle, _: LockOwner, reply: ReplyEmpty) {
        reply.ok() // close(2): durability comes from fsync and the flusher
    }

    fn readdir(
        &self,
        _: &Request,
        ino: INodeNo,
        _: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        if ino != INodeNo::ROOT {
            return reply.error(Errno::ENOTDIR);
        }
        let entries = [
            (INodeNo::ROOT, FileType::Directory, "."),
            (INodeNo::ROOT, FileType::Directory, ".."),
            (DISK, FileType::RegularFile, NAME),
        ];
        for (i, (ino, kind, name)) in entries.iter().enumerate().skip(offset as usize) {
            if reply.add(*ino, (i + 1) as u64, *kind, name) {
                break;
            }
        }
        reply.ok();
    }
}

/// The volume served as `<dir>/disk` until dropped.
pub struct DiskFile {
    dir: PathBuf,
    session: Option<fuser::BackgroundSession>,
}

impl DiskFile {
    /// The file that holds the volume.
    pub fn file(&self) -> PathBuf {
        self.dir.join(NAME)
    }
}

impl Drop for DiskFile {
    fn drop(&mut self) {
        drop(self.session.take()); // unmounts the FUSE filesystem
    }
}

/// Serves `device` as `<dir>/disk`.
pub fn serve_file(device: Arc<Device>, dir: &Path) -> Result<DiskFile> {
    std::fs::create_dir_all(dir)?;
    let fs = DiskFs {
        device,
        uid: unsafe { libc::getuid() },
        gid: unsafe { libc::getgid() },
        started: SystemTime::now(),
    };
    let mut config = Config::default();
    config.mount_options = vec![MountOption::FSName("blockd".into()), MountOption::RW];
    let session = fuser::spawn_mount(fs, dir, &config).with_context(|| {
        format!(
            "mounting the disk file at {} (is /dev/fuse available?)",
            dir.display()
        )
    })?;
    Ok(DiskFile {
        dir: dir.to_path_buf(),
        session: Some(session),
    })
}
