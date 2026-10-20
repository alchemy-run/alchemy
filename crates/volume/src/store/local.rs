use super::{BlobStore, MetaStore, check_head_name};
use crate::{Error, Hash, Result};
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

    fn read(&self, head: &str) -> Result<Option<Hash>> {
        match fs::read_to_string(self.root.join(head)) {
            Ok(text) => Hash::from_hex(text.trim())
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
    async fn get(&self, head: &str) -> Result<Option<Hash>> {
        check_head_name(head)?;
        self.read(head)
    }

    async fn cas(&self, head: &str, expected: Option<Hash>, new: Option<Hash>) -> Result<()> {
        check_head_name(head)?;
        let _guard = self.lock.lock().unwrap();
        let found = self.read(head)?;
        if found != expected {
            return Err(Error::Conflict {
                head: head.into(),
                expected,
                found,
            });
        }
        let path = self.root.join(head);
        match new {
            Some(id) => write_atomic(&path, id.to_hex().as_bytes()),
            None => fs::remove_file(path).map_err(Into::into),
        }
    }

    async fn list(&self) -> Result<Vec<(String, Hash)>> {
        let mut heads = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let name = entry?.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if let Some(id) = self.read(&name)? {
                heads.push((name, id));
            }
        }
        heads.sort();
        Ok(heads)
    }
}
