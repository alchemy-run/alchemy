use super::{BlobStore, MetaStore, check_head_name};
use crate::{Error, Hash, Result};
use async_trait::async_trait;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Objects in memory, for tests. Counts requests so tests can assert on
/// what a cache saved.
#[derive(Default)]
pub struct MemoryBlobStore {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    pub gets: AtomicU64,
    pub puts: AtomicU64,
}

impl MemoryBlobStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.objects.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn keys(&self) -> Vec<String> {
        self.objects.lock().unwrap().keys().cloned().collect()
    }
}

#[async_trait]
impl BlobStore for MemoryBlobStore {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.puts.fetch_add(1, Ordering::Relaxed);
        self.objects.lock().unwrap().insert(key.to_string(), bytes);
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        self.gets.fetch_add(1, Ordering::Relaxed);
        self.objects
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| Error::Missing(key.into()))
    }

    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>> {
        self.gets.fetch_add(1, Ordering::Relaxed);
        let objects = self.objects.lock().unwrap();
        let object = objects.get(key).ok_or_else(|| Error::Missing(key.into()))?;
        object
            .get(start as usize..end as usize)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| Error::Invalid(format!("range {start}..{end} of {key}")))
    }

    async fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.objects.lock().unwrap().contains_key(key))
    }
}

/// Heads in memory, for tests.
#[derive(Default)]
pub struct MemoryMetaStore {
    heads: Mutex<BTreeMap<String, Hash>>,
}

impl MemoryMetaStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl MetaStore for MemoryMetaStore {
    async fn get(&self, head: &str) -> Result<Option<Hash>> {
        Ok(self.heads.lock().unwrap().get(head).copied())
    }

    async fn cas(&self, head: &str, expected: Option<Hash>, new: Option<Hash>) -> Result<()> {
        check_head_name(head)?;
        let mut heads = self.heads.lock().unwrap();
        let found = heads.get(head).copied();
        if found != expected {
            return Err(Error::Conflict {
                head: head.into(),
                expected,
                found,
            });
        }
        match new {
            Some(id) => heads.insert(head.to_string(), id),
            None => heads.remove(head),
        };
        Ok(())
    }

    async fn list(&self) -> Result<Vec<(String, Hash)>> {
        Ok(self
            .heads
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect())
    }
}
