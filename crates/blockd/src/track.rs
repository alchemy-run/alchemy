//! Which paths a mounted head changed since its last checkpoint.
//!
//! A merge refuses a patch that changed a path the head changed since the
//! patch's base. Changes that reach the head as patches are logged with the
//! patch; this tracks the rest, written by commands running on the head
//! itself (a pinned session, a dev server).
//!
//! - **btrfs:** a read-only snapshot of the workspace at each checkpoint
//!   (`.alchemy/checkpoint`), and `btrfs send --no-data` against it.
//! - **ext4:** fanotify on the whole filesystem, from mount to detach. A
//!   change made through `mmap` alone isn't reported; nor is anything if the
//!   kernel's queue overflows, which [`Tracker::checkpoint`] reports as
//!   unknown.
//!
//! Changes this process makes itself (applying a patch) are not reported.

use crate::fs::{self, Fs};
use anyhow::{Result, bail};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const CHECKPOINT: &str = "checkpoint";

/// Tracks a mounted head's changes.
pub enum Tracker {
    Btrfs { data: PathBuf, snapshots: PathBuf },
    Fanotify(Arc<Watch>),
    /// Nothing can be tracked here: every checkpoint is unknown.
    None,
}

impl Tracker {
    /// Starts tracking the head mounted at `data`; for btrfs, `top` is its
    /// top level, mounted.
    pub fn start(fs: Fs, data: &Path, top: Option<&Path>) -> Self {
        let started = match (fs, top) {
            (Fs::Btrfs, Some(top)) => Self::start_btrfs(data, top),
            (Fs::Ext4, _) => Watch::start(data).map(Tracker::Fanotify),
            (Fs::Btrfs, None) => Err(anyhow::anyhow!("btrfs without its top level mounted")),
        };
        started.unwrap_or_else(|e| {
            tracing::warn!("tracking changes to {}: {e:#}", data.display());
            Tracker::None
        })
    }

    fn start_btrfs(data: &Path, top: &Path) -> Result<Self> {
        let snapshots = top.join(fs::SNAPSHOTS);
        std::fs::create_dir_all(&snapshots)?;
        fs::destroy(&snapshots, CHECKPOINT)?;
        fs::snapshot(data, &snapshots, CHECKPOINT, true)?;
        Ok(Tracker::Btrfs {
            data: data.to_path_buf(),
            snapshots,
        })
    }

    /// The paths changed since the last checkpoint (`None`: unknown, assume
    /// everything), and a new checkpoint from here.
    pub fn checkpoint(&self) -> Result<Option<Vec<String>>> {
        match self {
            Tracker::None => Ok(None),
            Tracker::Fanotify(watch) => Ok(watch.drain()),
            Tracker::Btrfs { data, snapshots } => {
                let next = "checkpoint-next";
                fs::destroy(snapshots, next)?;
                let current = fs::snapshot(data, snapshots, next, true)?;
                let base = snapshots.join(CHECKPOINT);
                let stream = fs::send(&current, &base, true)?;
                let touched = crate::sendstream::parse(&stream)?;
                let candidates = crate::patch::Candidates {
                    paths: touched.paths,
                    ranges: touched.ranges,
                    same_inodes: true,
                    ..Default::default()
                };
                let summary = crate::patch::create(&base, &current, &candidates, None)?;
                fs::destroy(snapshots, CHECKPOINT)?;
                std::fs::rename(&current, snapshots.join(CHECKPOINT))?;
                Ok(Some(summary.paths))
            }
        }
    }

    /// A checkpoint whose changes nobody needs (this process just made them).
    pub fn reset(&self) -> Result<()> {
        match self {
            Tracker::Btrfs { data, snapshots } => {
                fs::destroy(snapshots, CHECKPOINT)?;
                fs::snapshot(data, snapshots, CHECKPOINT, true)?;
                Ok(())
            }
            // fanotify already skips this process's own changes.
            Tracker::Fanotify(_) | Tracker::None => Ok(()),
        }
    }

    /// Stops tracking; a btrfs checkpoint is deleted.
    pub fn stop(&self) {
        match self {
            Tracker::Btrfs { snapshots, .. } => {
                let _ = fs::destroy(snapshots, CHECKPOINT);
            }
            Tracker::Fanotify(watch) => watch.stop(),
            Tracker::None => {}
        }
    }
}

//#region fanotify

const FAN_CLOEXEC: u32 = 0x1;
const FAN_UNLIMITED_QUEUE: u32 = 0x10;
const FAN_REPORT_DFID_NAME: u32 = 0x400 | 0x800;
const FAN_MARK_ADD: u32 = 0x1;
const FAN_MARK_FILESYSTEM: u32 = 0x100;
const FAN_MODIFY: u64 = 0x2;
const FAN_ATTRIB: u64 = 0x4;
const FAN_MOVED_FROM: u64 = 0x40;
const FAN_MOVED_TO: u64 = 0x80;
const FAN_CREATE: u64 = 0x100;
const FAN_DELETE: u64 = 0x200;
const FAN_Q_OVERFLOW: u64 = 0x4000;
const FAN_ONDIR: u64 = 0x4000_0000;
const FAN_EVENT_INFO_TYPE_DFID_NAME: u8 = 2;

/// fanotify on one mounted filesystem.
pub struct Watch {
    fd: i32,
    root: PathBuf,
    changed: Mutex<BTreeSet<String>>,
    overflowed: AtomicBool,
    stopped: AtomicBool,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Watch {
    pub fn start(root: &Path) -> Result<Arc<Self>> {
        let fd = unsafe {
            libc::fanotify_init(
                FAN_CLOEXEC | FAN_UNLIMITED_QUEUE | FAN_REPORT_DFID_NAME,
                (libc::O_RDONLY | libc::O_LARGEFILE) as u32,
            )
        };
        if fd < 0 {
            bail!("fanotify_init: {}", std::io::Error::last_os_error());
        }
        let path = std::ffi::CString::new(root.as_os_str().as_encoded_bytes())?;
        let mask =
            FAN_MODIFY | FAN_ATTRIB | FAN_MOVED_FROM | FAN_MOVED_TO | FAN_CREATE | FAN_DELETE | FAN_ONDIR;
        if unsafe {
            libc::fanotify_mark(
                fd,
                FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
                mask,
                libc::AT_FDCWD,
                path.as_ptr(),
            )
        } != 0
        {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(fd) };
            bail!("fanotify_mark {}: {error}", root.display());
        }
        let watch = Arc::new(Self {
            fd,
            root: std::fs::canonicalize(root)?,
            changed: Mutex::new(BTreeSet::new()),
            overflowed: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            reader: Mutex::new(None),
        });
        let reader = watch.clone();
        let thread = std::thread::Builder::new()
            .name("blockd-fanotify".into())
            .spawn(move || reader.read_events())?;
        *watch.reader.lock().unwrap() = Some(thread);
        Ok(watch)
    }

    /// The paths changed since the last drain, or `None` if events were lost.
    fn drain(&self) -> Option<Vec<String>> {
        let changed = std::mem::take(&mut *self.changed.lock().unwrap());
        if self.overflowed.swap(false, Ordering::AcqRel) {
            return None;
        }
        Some(changed.into_iter().collect())
    }

    /// Stops reading and closes everything it holds on the mount, so the
    /// mount can unmount.
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.reader.lock().unwrap().take() {
            let _ = thread.join();
        }
    }

    fn read_events(&self) {
        let me = std::process::id() as i32;
        let mount = match std::fs::File::open(&self.root) {
            Ok(file) => file,
            Err(e) => {
                tracing::warn!("fanotify: opening {}: {e}", self.root.display());
                self.overflowed.store(true, Ordering::Release);
                return;
            }
        };
        let mut buffer = vec![0u8; 64 * 1024];
        while !self.stopped.load(Ordering::Acquire) {
            let mut poll = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut poll, 1, 100) } <= 0 {
                continue;
            }
            let n = unsafe { libc::read(self.fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if n <= 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            let mut at = 0usize;
            let n = n as usize;
            while at + 24 <= n {
                let event = &buffer[at..n];
                let event_len = u32::from_ne_bytes(event[0..4].try_into().unwrap()) as usize;
                let metadata_len = u16::from_ne_bytes(event[6..8].try_into().unwrap()) as usize;
                let mask = u64::from_ne_bytes(event[8..16].try_into().unwrap());
                let pid = i32::from_ne_bytes(event[20..24].try_into().unwrap());
                if event_len < metadata_len || event_len > event.len() {
                    break;
                }
                if mask & FAN_Q_OVERFLOW != 0 {
                    self.overflowed.store(true, Ordering::Release);
                } else if pid != me
                    && let Some(path) = self.resolve(&mount, &event[metadata_len..event_len])
                {
                    // (Unresolved: a directory deleted before we looked. Its own
                    // deletion was reported against its parent.)
                    self.changed.lock().unwrap().insert(path);
                }
                at += event_len;
            }
        }
        unsafe { libc::close(self.fd) };
    }

    /// The path an event's directory handle and name name, relative to root.
    fn resolve(&self, mount: &std::fs::File, info: &[u8]) -> Option<String> {
        use std::os::fd::AsRawFd;
        if info.len() < 4 || info[0] != FAN_EVENT_INFO_TYPE_DFID_NAME {
            return None;
        }
        let len = u16::from_ne_bytes([info[2], info[3]]) as usize;
        let record = info.get(4..len)?;
        // fsid (8 bytes), then a struct file_handle, then the name.
        let handle = record.get(8..)?;
        let handle_bytes = u32::from_ne_bytes(handle.get(0..4)?.try_into().ok()?) as usize;
        let handle_len = 8 + handle_bytes;
        let name_bytes = handle.get(handle_len..)?;
        let name = name_bytes.split(|&b| b == 0).next().unwrap_or_default();
        let mut owned = handle[..handle_len].to_vec();
        let fd = unsafe {
            libc::syscall(
                libc::SYS_open_by_handle_at,
                mount.as_raw_fd(),
                owned.as_mut_ptr(),
                libc::O_PATH | libc::O_CLOEXEC,
            )
        } as i32;
        if fd < 0 {
            return None;
        }
        let dir = std::fs::read_link(format!("/proc/self/fd/{fd}"));
        unsafe { libc::close(fd) };
        let dir = dir.ok()?;
        let relative = dir.strip_prefix(&self.root).ok()?.to_string_lossy().into_owned();
        let name = String::from_utf8_lossy(name);
        let path = match (relative.is_empty(), name == "." || name.is_empty()) {
            (true, true) => return None, // the root itself
            (true, false) => name.into_owned(),
            (false, true) => relative,
            (false, false) => format!("{relative}/{name}"),
        };
        Some(path)
    }
}

//#endregion
