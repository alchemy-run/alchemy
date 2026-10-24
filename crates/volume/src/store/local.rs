use super::{BlobMeta, BlobStore, Head, MetaStore, check_head_name, conflict};
use crate::{Error, Result};
use async_trait::async_trait;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Objects as files under a directory: for development, tests, and stores
/// on a mounted disk. Writes go to a temporary file and are renamed into
/// place, so a reader never sees half an object.
pub struct LocalBlobStore {
    root: PathBuf,
}

impl LocalBlobStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn path(&self, key: &str) -> Result<PathBuf> {
        if key
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(Error::Invalid(format!("key {key:?}")));
        }
        Ok(self.root.join(key))
    }
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = tempfile_in(path)?;
    tmp.1.write_all(bytes)?;
    tmp.1.sync_all()?;
    fs::rename(&tmp.0, path)?;
    Ok(())
}

fn tempfile_in(path: &Path) -> Result<(PathBuf, fs::File)> {
    let dir = path.parent().unwrap_or(Path::new("."));
    for attempt in 0..16u32 {
        let name = format!(
            ".{}.{}.{attempt}.tmp",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("object"),
            std::process::id()
        );
        let candidate = dir.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::Store(format!(
        "no temporary file for {}",
        path.display()
    )))
}

fn not_found(key: &str) -> impl Fn(std::io::Error) -> Error + '_ {
    move |e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::Missing(key.into())
        } else {
            e.into()
        }
    }
}

#[async_trait]
impl BlobStore for LocalBlobStore {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        let path = self.path(key)?;
        if path.exists() {
            return Ok(()); // content-addressed: already the same bytes
        }
        write_atomic(&path, &bytes)
    }

    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        let path = self.path(key)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        // Write aside, then link into place: linking fails if the key exists,
        // and a reader never sees half an object.
        let (tmp, mut file) = tempfile_in(&path)?;
        let written = file.write_all(&bytes).and_then(|()| file.sync_all());
        let linked = written.and_then(|()| fs::hard_link(&tmp, &path));
        let _ = fs::remove_file(&tmp);
        match linked {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        fs::read(self.path(key)?).map_err(not_found(key))
    }

    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>> {
        let mut file = fs::File::open(self.path(key)?).map_err(not_found(key))?;
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; (end - start) as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    async fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.path(key)?.exists())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<BlobMeta>> {
        let mut found = Vec::new();
        walk(&self.root, &self.root, prefix, &mut found)?;
        found.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(found)
    }

    async fn delete(&self, key: &str) -> Result<()> {
        match fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

fn walk(root: &Path, dir: &Path, prefix: &str, out: &mut Vec<BlobMeta>) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue; // temporary files
        }
        if entry.file_type()?.is_dir() {
            walk(root, &path, prefix, out)?;
            continue;
        }
        let key = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if key.starts_with(prefix) {
            let meta = entry.metadata()?;
            out.push(BlobMeta {
                key,
                size: meta.len(),
                modified: meta.modified()?,
            });
        }
    }
    Ok(())
}

/// Heads as files under a directory. Compare-and-set is serialized within
/// this process; use one `LocalMetaStore` per directory.
pub struct LocalMetaStore {
    root: PathBuf,
    lock: Mutex<()>,
}

impl LocalMetaStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            lock: Mutex::new(()),
        })
    }

    fn read(&self, head: &str) -> Result<Option<Head>> {
        match fs::read(self.root.join(head)) {
            Ok(bytes) => Head::decode(&bytes)
                .map(Some)
                .ok_or_else(|| Error::Corrupt {
                    key: head.into(),
                    reason: "bad head".into(),
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

#[async_trait]
impl MetaStore for LocalMetaStore {
    async fn get(&self, head: &str) -> Result<Option<Head>> {
        check_head_name(head)?;
        self.read(head)
    }

    async fn cas(&self, head: &str, expected: Option<&Head>, new: Option<&Head>) -> Result<()> {
        check_head_name(head)?;
        let _guard = self.lock.lock().unwrap();
        let found = self.read(head)?;
        if found.as_ref() != expected {
            return Err(conflict(head, expected, found.as_ref()));
        }
        let path = self.root.join(head);
        match new {
            Some(record) => write_atomic(&path, &record.encode()),
            None => fs::remove_file(path).map_err(Into::into),
        }
    }

    async fn list(&self) -> Result<Vec<(String, Head)>> {
        let mut heads = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let name = entry?.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if let Some(record) = self.read(&name)? {
                heads.push((name, record));
            }
        }
        heads.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(heads)
    }
}
