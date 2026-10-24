//! A patch: what a command changed in a workspace, as operations on paths,
//! made on the machine that ran it and applied to a head on another.
//!
//! ```text
//! delete   src/old.ts                 (recursive)
//! dir      newdir                     mode, owner, xattrs
//! file     src/world.ts               whole, or byte ranges of the file at the base
//! symlink  link -> target
//! special  a fifo, socket or device node
//! ```
//!
//! A patch is made by comparing two trees, the command's **base** and its
//! **current** state, at a set of *candidate* paths: the ones an overlay's
//! upper layer holds, or the ones a `btrfs send` stream names. Comparing at
//! candidates rather than walking everything keeps it proportional to what
//! changed. [`walk_candidates`] walks everything, for two trees nobody
//! tracked (merging whole forks).
//!
//! Byte ranges are only used when the file kept its identity (same inode
//! number, which btrfs keeps across snapshots) and most of it is unchanged.
//! They're valid on the head only if the head's file is still the base's,
//! which the merge's conflict check guarantees.
//!
//! **Format.** `ALCHPATCH1\n`, then records `u32 header length, header JSON,
//! u64 data length, data`, ending with a zero header length. The first record
//! describes the patch; data follows the operation it belongs to.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

const MAGIC: &[u8] = b"ALCHPATCH1\n";

/// Where to look for changes, and what's known about them.
#[derive(Debug, Default)]
pub struct Candidates {
    pub paths: BTreeSet<String>,
    /// Directories whose contents were replaced wholesale (an overlay's
    /// opaque directory): emitted whole, never merged with the base's.
    pub replaced: BTreeSet<String>,
    /// Byte ranges known to be written, per path.
    pub ranges: BTreeMap<String, Vec<(u64, u64)>>,
    /// Paths to delete even though the base doesn't have them: a commit
    /// after the first, of something an earlier commit created.
    pub deleted: BTreeSet<String>,
    /// Inode numbers mean the same thing in both trees (btrfs snapshots).
    pub same_inodes: bool,
}

/// What a patch changes: its operations' paths (a created directory is one
/// path, not its whole subtree) and how many bytes of file data it carries.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub paths: Vec<String>,
    pub bytes: u64,
    pub operations: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    /// Seconds and nanoseconds.
    pub mtime: (i64, i64),
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub xattrs: Vec<(String, Vec<u8>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Patch {
        version: u32,
    },
    Delete {
        path: String,
    },
    Dir {
        path: String,
        meta: Meta,
    },
    File {
        path: String,
        meta: Meta,
        size: u64,
        /// The ranges whose bytes follow; absent, the whole file follows.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ranges: Option<Vec<(u64, u64)>>,
    },
    Symlink {
        path: String,
        meta: Meta,
        target: String,
    },
    Special {
        path: String,
        meta: Meta,
        rdev: u64,
    },
}

//#region making a patch

/// Writes the patch from `base` to `current` at `candidates` to `out`
/// (`None` only computes the summary).
pub fn create(
    base: &Path,
    current: &Path,
    candidates: &Candidates,
    out: Option<&mut dyn Write>,
) -> Result<Summary> {
    let mut writer = Writer {
        out,
        summary: Summary::default(),
    };
    if let Some(out) = writer.out.as_mut() {
        out.write_all(MAGIC)?;
    }
    writer.record(&Op::Patch { version: 1 }, &[])?;
    // Subtrees already emitted whole (or deleted): their paths are skipped.
    let mut covered: BTreeSet<String> = BTreeSet::new();
    let is_covered = |covered: &BTreeSet<String>, path: &str| {
        path.match_indices('/')
            .map(|(at, _)| &path[..at])
            .chain([path])
            .any(|ancestor| covered.contains(ancestor))
    };
    for path in &candidates.paths {
        let Some(path) = clean(path) else { continue };
        if path.is_empty() {
            continue;
        }
        if is_covered(&covered, &path) {
            continue;
        }
        let old = lstat(&base.join(&path));
        let new = lstat(&current.join(&path));
        match (old, new) {
            (None, None) => {
                if candidates.deleted.contains(&path) {
                    writer.delete(&path)?;
                    covered.insert(path);
                }
            }
            (Some(_), None) => {
                writer.delete(&path)?;
                covered.insert(path);
            }
            (None, Some(_)) => {
                writer.tree(current, &path)?;
                covered.insert(path);
            }
            (Some(old), Some(new)) => {
                let same_kind = old.file_type() == new.file_type();
                let same_inode = !candidates.same_inodes || old.ino() == new.ino();
                if !same_kind
                    || (new.is_dir() && (!same_inode || candidates.replaced.contains(&path)))
                {
                    writer.delete(&path)?;
                    writer.tree(current, &path)?;
                    covered.insert(path);
                    continue;
                }
                let old_meta = meta(&base.join(&path), &old)?;
                let new_meta = meta(&current.join(&path), &new)?;
                let kind = new.file_type();
                if kind.is_dir() {
                    // A directory's mtime moves with every child: not a change of its own.
                    if (old_meta.mode, old_meta.uid, old_meta.gid, &old_meta.xattrs)
                        != (new_meta.mode, new_meta.uid, new_meta.gid, &new_meta.xattrs)
                    {
                        writer.dir(&path, new_meta)?;
                    }
                } else if kind.is_file() {
                    let ranges = if same_inode && candidates.same_inodes {
                        candidates.ranges.get(&path)
                    } else {
                        None
                    };
                    match ranges {
                        Some(ranges) if useful(ranges, new.len()) => {
                            writer.ranges(current, &path, new_meta, new.len(), ranges)?
                        }
                        _ if !candidates.same_inodes
                            || old_meta != new_meta
                            || old.len() != new.len()
                            || ranges.is_some()
                            || !same_inode =>
                        {
                            writer.file(current, &path, new_meta, new.len())?
                        }
                        _ => {}
                    }
                } else if kind.is_symlink() {
                    let old_target = std::fs::read_link(base.join(&path))?;
                    let new_target = std::fs::read_link(current.join(&path))?;
                    if old_target != new_target || old_meta != new_meta {
                        writer.delete(&path)?;
                        writer.symlink(&path, new_meta, &new_target)?;
                    }
                } else if old.rdev() != new.rdev() || old_meta != new_meta {
                    writer.delete(&path)?;
                    writer.special(&path, new_meta, new.rdev())?;
                }
            }
        }
    }
    let end = 0u32.to_le_bytes();
    if let Some(out) = writer.out.as_mut() {
        out.write_all(&end)?;
        out.flush()?;
    }
    Ok(writer.summary)
}

/// Ranges are worth sending if they cover at most half the file.
fn useful(ranges: &[(u64, u64)], size: u64) -> bool {
    let total: u64 = ranges.iter().map(|&(_, len)| len).sum();
    total.saturating_mul(2) <= size
}

struct Writer<'a> {
    out: Option<&'a mut dyn Write>,
    summary: Summary,
}

impl Writer<'_> {
    fn record(&mut self, op: &Op, data: &[u8]) -> Result<()> {
        self.header(op, data.len() as u64)?;
        if let Some(out) = self.out.as_mut() {
            out.write_all(data)?;
        }
        Ok(())
    }

    fn header(&mut self, op: &Op, data_len: u64) -> Result<()> {
        if !matches!(op, Op::Patch { .. }) {
            self.summary.operations += 1;
            self.summary.bytes += data_len;
        }
        if let Some(out) = self.out.as_mut() {
            let header = serde_json::to_vec(op)?;
            out.write_all(&(header.len() as u32).to_le_bytes())?;
            out.write_all(&header)?;
            out.write_all(&data_len.to_le_bytes())?;
        }
        Ok(())
    }

    fn touch(&mut self, path: &str) {
        self.summary.paths.push(path.to_string());
    }

    fn delete(&mut self, path: &str) -> Result<()> {
        self.touch(path);
        self.record(&Op::Delete { path: path.into() }, &[])
    }

    fn dir(&mut self, path: &str, meta: Meta) -> Result<()> {
        self.touch(path);
        self.record(&Op::Dir { path: path.into(), meta }, &[])
    }

    fn symlink(&mut self, path: &str, meta: Meta, target: &Path) -> Result<()> {
        self.touch(path);
        let target = target.to_string_lossy().into_owned();
        self.record(&Op::Symlink { path: path.into(), meta, target }, &[])
    }

    fn special(&mut self, path: &str, meta: Meta, rdev: u64) -> Result<()> {
        self.touch(path);
        self.record(&Op::Special { path: path.into(), meta, rdev }, &[])
    }

    fn file(&mut self, root: &Path, path: &str, meta: Meta, size: u64) -> Result<()> {
        self.touch(path);
        let op = Op::File {
            path: path.into(),
            meta,
            size,
            ranges: None,
        };
        self.header(&op, size)?;
        if let Some(out) = self.out.as_mut() {
            let mut file = File::open(root.join(path))?;
            let copied = std::io::copy(&mut (&mut file).take(size), out)?;
            if copied != size {
                bail!("{path} shrank while its patch was made");
            }
        }
        Ok(())
    }

    fn ranges(
        &mut self,
        root: &Path,
        path: &str,
        meta: Meta,
        size: u64,
        ranges: &[(u64, u64)],
    ) -> Result<()> {
        self.touch(path);
        // Clip to the file's size: a later truncate may have cut a write.
        let ranges: Vec<(u64, u64)> = ranges
            .iter()
            .filter(|&&(offset, _)| offset < size)
            .map(|&(offset, len)| (offset, len.min(size - offset)))
            .filter(|&(_, len)| len > 0)
            .collect();
        let total: u64 = ranges.iter().map(|&(_, len)| len).sum();
        let op = Op::File {
            path: path.into(),
            meta,
            size,
            ranges: Some(ranges.clone()),
        };
        self.header(&op, total)?;
        if let Some(out) = self.out.as_mut() {
            let file = File::open(root.join(path))?;
            let mut buffer = Vec::new();
            for (offset, len) in ranges {
                buffer.resize(len as usize, 0);
                file.read_exact_at(&mut buffer, offset)?;
                out.write_all(&buffer)?;
            }
        }
        Ok(())
    }

    /// `path` and, for a directory, everything under it, whole.
    fn tree(&mut self, root: &Path, path: &str) -> Result<()> {
        let full = root.join(path);
        let stat = std::fs::symlink_metadata(&full)?;
        let meta = meta(&full, &stat)?;
        let kind = stat.file_type();
        if kind.is_dir() {
            self.dir(path, meta)?;
            let mut names: Vec<_> = std::fs::read_dir(&full)?
                .map(|entry| entry.map(|e| e.file_name()))
                .collect::<std::io::Result<_>>()?;
            names.sort();
            for name in names {
                let child = format!("{path}/{}", name.to_string_lossy());
                // One path for the whole subtree: the summary stays small.
                let touched = self.summary.paths.len();
                self.tree(root, &child)?;
                self.summary.paths.truncate(touched);
            }
            Ok(())
        } else if kind.is_file() {
            self.file(root, path, meta, stat.len())
        } else if kind.is_symlink() {
            let target = std::fs::read_link(&full)?;
            self.symlink(path, meta, &target)
        } else {
            self.special(path, meta, stat.rdev())
        }
    }
}

/// Candidates for an overlay: everything its upper layer holds. A whiteout
/// is a deletion, and an opaque directory replaced the base's.
pub fn overlay_candidates(upper: &Path) -> Result<Candidates> {
    let mut candidates = Candidates::default();
    walk_upper(upper, upper, &mut candidates)?;
    Ok(candidates)
}

fn walk_upper(upper: &Path, dir: &Path, candidates: &mut Candidates) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let full = entry.path();
        let path = relative(upper, &full);
        let stat = std::fs::symlink_metadata(&full)?;
        candidates.paths.insert(path.clone());
        if stat.is_dir() {
            let opaque = ["trusted.overlay.opaque", "user.overlay.opaque"]
                .iter()
                .any(|name| get_xattr(&full, name).is_ok_and(|v| v.as_deref() == Some(b"y")));
            if opaque {
                candidates.replaced.insert(path);
            } else {
                walk_upper(upper, &full, candidates)?;
            }
        }
    }
    Ok(())
}

/// Candidates for two trees nobody tracked: every path whose entry differs.
/// Walks both trees; a directory whose entry is unchanged is still walked.
pub fn walk_candidates(base: &Path, current: &Path, same_inodes: bool) -> Result<Candidates> {
    let mut candidates = Candidates {
        same_inodes,
        ..Candidates::default()
    };
    walk_pair(base, current, "", &mut candidates)?;
    Ok(candidates)
}

fn walk_pair(base: &Path, current: &Path, path: &str, candidates: &mut Candidates) -> Result<()> {
    let names = |root: &Path| -> BTreeSet<std::ffi::OsString> {
        std::fs::read_dir(root.join(path))
            .map(|entries| entries.flatten().map(|e| e.file_name()).collect())
            .unwrap_or_default()
    };
    let mut all = names(base);
    all.extend(names(current));
    for name in all {
        let child = if path.is_empty() {
            name.to_string_lossy().into_owned()
        } else {
            format!("{path}/{}", name.to_string_lossy())
        };
        let old = lstat(&base.join(&child));
        let new = lstat(&current.join(&child));
        let changed = match (&old, &new) {
            (Some(old), Some(new)) => {
                old.file_type() != new.file_type()
                    || old.mode() != new.mode()
                    || old.uid() != new.uid()
                    || old.gid() != new.gid()
                    || (!old.is_dir()
                        && (old.len() != new.len()
                            || old.mtime() != new.mtime()
                            || old.mtime_nsec() != new.mtime_nsec()
                            || old.ctime() != new.ctime()
                            || old.ctime_nsec() != new.ctime_nsec()))
                    || (candidates.same_inodes && old.ino() != new.ino())
            }
            _ => true,
        };
        if changed {
            candidates.paths.insert(child.clone());
        }
        let both_dirs = old.as_ref().is_some_and(|m| m.is_dir()) && new.as_ref().is_some_and(|m| m.is_dir());
        if both_dirs {
            walk_pair(base, current, &child, candidates)?;
        }
    }
    Ok(())
}

//#endregion

//#region applying a patch

/// Applies the patch read from `input` to the tree at `target`. Returns its
/// summary.
pub fn apply(input: &mut dyn Read, target: &Path) -> Result<Summary> {
    let mut magic = [0u8; MAGIC.len()];
    input.read_exact(&mut magic).context("reading a patch")?;
    if magic != MAGIC {
        bail!("not a patch");
    }
    let mut summary = Summary::default();
    // Directory times are set last: creating children moves them.
    let mut dir_times: Vec<(PathBuf, (i64, i64))> = Vec::new();
    loop {
        let mut len = [0u8; 4];
        input.read_exact(&mut len)?;
        let len = u32::from_le_bytes(len) as usize;
        if len == 0 {
            break;
        }
        let mut header = vec![0u8; len];
        input.read_exact(&mut header)?;
        let op: Op = serde_json::from_slice(&header).context("a patch operation")?;
        let mut data_len = [0u8; 8];
        input.read_exact(&mut data_len)?;
        let data_len = u64::from_le_bytes(data_len);
        let mut data = input.take(data_len);
        if !matches!(op, Op::Patch { .. }) {
            summary.operations += 1;
            summary.bytes += data_len;
        }
        match op {
            Op::Patch { version } => {
                if version != 1 {
                    bail!("patch version {version}");
                }
            }
            Op::Delete { path } => {
                let full = inside(target, &path)?;
                summary.paths.push(path);
                remove(&full)?;
            }
            Op::Dir { path, meta } => {
                let full = inside(target, &path)?;
                summary.paths.push(path);
                match std::fs::symlink_metadata(&full) {
                    Ok(stat) if stat.is_dir() => {}
                    Ok(_) => {
                        remove(&full)?;
                        std::fs::create_dir(&full)?;
                    }
                    Err(_) => std::fs::create_dir_all(&full)?,
                }
                set_meta(&full, &meta, false)?;
                dir_times.push((full, meta.mtime));
            }
            Op::File {
                path,
                meta,
                size,
                ranges,
            } => {
                let full = inside(target, &path)?;
                summary.paths.push(path.clone());
                match ranges {
                    None => {
                        // Whole files land atomically: a reader sees the old or the new.
                        let parent = full.parent().context("a file at the root")?;
                        std::fs::create_dir_all(parent)?;
                        let temporary = parent.join(format!(
                            ".{}.alchemy-{}",
                            full.file_name().unwrap_or_default().to_string_lossy(),
                            std::process::id()
                        ));
                        let mut file = File::create(&temporary)?;
                        let copied = std::io::copy(&mut data, &mut file)?;
                        if copied != size {
                            bail!("the patch ended inside {path}");
                        }
                        drop(file);
                        set_meta(&temporary, &meta, false)?;
                        if std::fs::symlink_metadata(&full).is_ok_and(|stat| stat.is_dir()) {
                            std::fs::remove_dir_all(&full)?;
                        }
                        std::fs::rename(&temporary, &full)?;
                    }
                    Some(ranges) => {
                        let file = OpenOptions::new().write(true).open(&full).with_context(|| {
                            format!("{path} changes part of a file the head doesn't have")
                        })?;
                        file.set_len(size)?;
                        let mut buffer = Vec::new();
                        for (offset, len) in ranges {
                            buffer.resize(len as usize, 0);
                            data.read_exact(&mut buffer)?;
                            file.write_all_at(&buffer, offset)?;
                        }
                        drop(file);
                        set_meta(&full, &meta, false)?;
                    }
                }
            }
            Op::Symlink { path, meta, target: link } => {
                let full = inside(target, &path)?;
                summary.paths.push(path);
                remove(&full)?;
                if let Some(parent) = full.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::os::unix::fs::symlink(&link, &full)?;
                set_meta(&full, &meta, true)?;
            }
            Op::Special { path, meta, rdev } => {
                let full = inside(target, &path)?;
                summary.paths.push(path);
                remove(&full)?;
                let name = c_path(&full)?;
                if unsafe { libc::mknod(name.as_ptr(), meta.mode, rdev as libc::dev_t) } != 0 {
                    bail!("mknod {}: {}", full.display(), std::io::Error::last_os_error());
                }
                set_meta(&full, &meta, false)?;
            }
        }
        // Whatever an operation didn't read of its data is skipped.
        std::io::copy(&mut data, &mut std::io::sink())?;
    }
    for (dir, mtime) in dir_times.into_iter().rev() {
        set_times(&dir, mtime, false)?;
    }
    Ok(summary)
}

/// Reads only a patch's summary.
pub fn summarize(input: &mut dyn Read) -> Result<Summary> {
    let mut magic = [0u8; MAGIC.len()];
    input.read_exact(&mut magic)?;
    if magic != MAGIC {
        bail!("not a patch");
    }
    let mut summary = Summary::default();
    loop {
        let mut len = [0u8; 4];
        input.read_exact(&mut len)?;
        let len = u32::from_le_bytes(len) as usize;
        if len == 0 {
            return Ok(summary);
        }
        let mut header = vec![0u8; len];
        input.read_exact(&mut header)?;
        let op: Op = serde_json::from_slice(&header)?;
        let mut data_len = [0u8; 8];
        input.read_exact(&mut data_len)?;
        let data_len = u64::from_le_bytes(data_len);
        std::io::copy(&mut input.take(data_len), &mut std::io::sink())?;
        let path = match op {
            Op::Patch { .. } => continue,
            Op::Delete { path }
            | Op::Dir { path, .. }
            | Op::File { path, .. }
            | Op::Symlink { path, .. }
            | Op::Special { path, .. } => path,
        };
        summary.operations += 1;
        summary.bytes += data_len;
        summary.paths.push(path);
    }
}

fn remove(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(stat) if stat.is_dir() => std::fs::remove_dir_all(path)?,
        Ok(_) => std::fs::remove_file(path)?,
        Err(_) => {}
    }
    Ok(())
}

//#endregion

//#region paths and metadata

/// A path with `.` removed, or `None` if it's absolute or climbs out.
fn clean(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// `target/path`, refusing paths that would leave `target`.
fn inside(target: &Path, path: &str) -> Result<PathBuf> {
    match clean(path) {
        Some(clean) if !clean.is_empty() => Ok(target.join(clean)),
        _ => bail!("the patch names {path:?}, outside the workspace"),
    }
}

/// Whether `path` is `root` or under it.
pub fn under(path: &str, root: &str) -> bool {
    path == root || (path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/'))
}

fn relative(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .unwrap_or(full)
        .to_string_lossy()
        .into_owned()
}

fn lstat(path: &Path) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(path).ok()
}

fn c_path(path: &Path) -> Result<CString> {
    Ok(CString::new(path.as_os_str().as_bytes())?)
}

fn meta(path: &Path, stat: &std::fs::Metadata) -> Result<Meta> {
    Ok(Meta {
        mode: stat.mode(),
        uid: stat.uid(),
        gid: stat.gid(),
        mtime: (stat.mtime(), stat.mtime_nsec()),
        xattrs: list_xattrs(path)?,
    })
}

fn list_xattrs(path: &Path) -> Result<Vec<(String, Vec<u8>)>> {
    let name = c_path(path)?;
    let len = unsafe { libc::llistxattr(name.as_ptr(), std::ptr::null_mut(), 0) };
    if len <= 0 {
        return Ok(Vec::new()); // none, or a filesystem without xattrs
    }
    let mut names = vec![0u8; len as usize];
    let len = unsafe { libc::llistxattr(name.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
    if len < 0 {
        return Ok(Vec::new());
    }
    names.truncate(len as usize);
    let mut out = Vec::new();
    for key in names.split(|&b| b == 0).filter(|k| !k.is_empty()) {
        let key = String::from_utf8_lossy(key).into_owned();
        // Overlay's own bookkeeping never belongs to the workspace.
        if key.starts_with("trusted.overlay.") || key.starts_with("user.overlay.") {
            continue;
        }
        if let Some(value) = get_xattr(path, &key)? {
            out.push((key, value));
        }
    }
    out.sort();
    Ok(out)
}

fn get_xattr(path: &Path, key: &str) -> Result<Option<Vec<u8>>> {
    let name = c_path(path)?;
    let key = CString::new(key)?;
    let len = unsafe { libc::lgetxattr(name.as_ptr(), key.as_ptr(), std::ptr::null_mut(), 0) };
    if len < 0 {
        return Ok(None);
    }
    let mut value = vec![0u8; len as usize];
    let len = unsafe {
        libc::lgetxattr(
            name.as_ptr(),
            key.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    if len < 0 {
        return Ok(None);
    }
    value.truncate(len as usize);
    Ok(Some(value))
}

fn set_meta(path: &Path, meta: &Meta, symlink: bool) -> Result<()> {
    let name = c_path(path)?;
    if unsafe { libc::lchown(name.as_ptr(), meta.uid, meta.gid) } != 0 {
        tracing::debug!("lchown {}: {}", path.display(), std::io::Error::last_os_error());
    }
    if !symlink {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(meta.mode & 0o7777))?;
    }
    let wanted: BTreeMap<&str, &[u8]> =
        meta.xattrs.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect();
    for (key, _) in list_xattrs(path)? {
        if !wanted.contains_key(key.as_str()) {
            let key = CString::new(key)?;
            unsafe { libc::lremovexattr(name.as_ptr(), key.as_ptr()) };
        }
    }
    for (key, value) in wanted {
        let key = CString::new(key)?;
        if unsafe {
            libc::lsetxattr(name.as_ptr(), key.as_ptr(), value.as_ptr().cast(), value.len(), 0)
        } != 0
        {
            tracing::debug!("lsetxattr {}: {}", path.display(), std::io::Error::last_os_error());
        }
    }
    set_times(path, meta.mtime, symlink)
}

fn set_times(path: &Path, (seconds, nanos): (i64, i64), symlink: bool) -> Result<()> {
    let name = c_path(path)?;
    let times = [
        libc::timespec {
            tv_sec: 0,
            tv_nsec: libc::UTIME_OMIT,
        },
        libc::timespec {
            tv_sec: seconds as libc::time_t,
            tv_nsec: nanos as _,
        },
    ];
    let flags = if symlink { libc::AT_SYMLINK_NOFOLLOW } else { 0 };
    if unsafe { libc::utimensat(libc::AT_FDCWD, name.as_ptr(), times.as_ptr(), flags) } != 0 {
        tracing::debug!("utimensat {}: {}", path.display(), std::io::Error::last_os_error());
    }
    Ok(())
}

//#endregion
