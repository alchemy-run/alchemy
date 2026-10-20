//! S3, R2 and GCS (through its S3-compatible API) via `object_store`.
//!
//! Blobs are written with `If-None-Match: *`; heads are small objects moved
//! with conditional writes (`If-Match` on the ETag), so an S3 bucket alone is
//! a complete volume store.

use super::{BlobMeta, BlobStore, Head, MetaStore, check_head_name, conflict};
use crate::{Error, Result};
use async_trait::async_trait;
use object_store::path::Path;
use object_store::{ObjectStore, PutMode, PutOptions, PutPayload, UpdateVersion};
use std::sync::Arc;

fn store_error(e: object_store::Error) -> Error {
    Error::Store(e.to_string())
}

/// Immutable objects in a bucket, under `prefix`.
pub struct ObjectBlobStore {
    store: Arc<dyn ObjectStore>,
    prefix: String,
}

impl ObjectBlobStore {
    pub fn new(store: Arc<dyn ObjectStore>, prefix: impl Into<String>) -> Self {
        Self {
            store,
            prefix: prefix.into(),
        }
    }

    fn path(&self, key: &str) -> Path {
        Path::from(format!("{}/{key}", self.prefix.trim_end_matches('/')))
    }
}

#[async_trait]
impl BlobStore for ObjectBlobStore {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        let options = PutOptions {
            mode: PutMode::Create,
            ..Default::default()
        };
        match self
            .store
            .put_opts(&self.path(key), PutPayload::from(bytes), options)
            .await
        {
            Ok(_) | Err(object_store::Error::AlreadyExists { .. }) => Ok(()),
            // Stores without conditional create report a precondition failure the same way.
            Err(object_store::Error::Precondition { .. }) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }

    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        let options = PutOptions {
            mode: PutMode::Create,
            ..Default::default()
        };
        match self
            .store
            .put_opts(&self.path(key), PutPayload::from(bytes), options)
            .await
        {
            Ok(_) => Ok(true),
            Err(
                object_store::Error::AlreadyExists { .. }
                | object_store::Error::Precondition { .. },
            ) => Ok(false),
            Err(e) => Err(store_error(e)),
        }
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        match self.store.get(&self.path(key)).await {
            Ok(result) => Ok(result.bytes().await.map_err(store_error)?.to_vec()),
            Err(object_store::Error::NotFound { .. }) => Err(Error::Missing(key.into())),
            Err(e) => Err(store_error(e)),
        }
    }

    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>> {
        match self.store.get_range(&self.path(key), start..end).await {
            Ok(bytes) => Ok(bytes.to_vec()),
            Err(object_store::Error::NotFound { .. }) => Err(Error::Missing(key.into())),
            Err(e) => Err(store_error(e)),
        }
    }

    async fn exists(&self, key: &str) -> Result<bool> {
        match self.store.head(&self.path(key)).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(e) => Err(store_error(e)),
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<BlobMeta>> {
        use futures::StreamExt;
        let root = format!("{}/", self.prefix.trim_end_matches('/'));
        let mut stream = self.store.list(Some(&Path::from(format!(
            "{root}{}",
            prefix.trim_end_matches('/')
        ))));
        let mut found = Vec::new();
        while let Some(meta) = stream.next().await {
            let meta = meta.map_err(store_error)?;
            let Some(key) = meta.location.as_ref().strip_prefix(&root) else {
                continue;
            };
            if key.starts_with(prefix) && !key.starts_with("heads/") {
                found.push(BlobMeta {
                    key: key.to_string(),
                    size: meta.size,
                    modified: meta.last_modified.into(),
                });
            }
        }
        found.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(found)
    }

    async fn delete(&self, key: &str) -> Result<()> {
        match self.store.delete(&self.path(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

/// Heads as objects under `prefix/heads/`, replaced with conditional writes.
/// The bucket must support them (S3, R2 and GCS do).
pub struct ObjectMetaStore {
    store: Arc<dyn ObjectStore>,
    prefix: String,
}

impl ObjectMetaStore {
    pub fn new(store: Arc<dyn ObjectStore>, prefix: impl Into<String>) -> Self {
        Self {
            store,
            prefix: prefix.into(),
        }
    }

    fn path(&self, head: &str) -> Path {
        Path::from(format!(
            "{}/heads/{head}",
            self.prefix.trim_end_matches('/')
        ))
    }

    async fn read(&self, head: &str) -> Result<Option<(Head, Option<String>)>> {
        match self.store.get(&self.path(head)).await {
            Ok(result) => {
                let e_tag = result.meta.e_tag.clone();
                let bytes = result.bytes().await.map_err(store_error)?;
                let record = Head::decode(&bytes).ok_or_else(|| Error::Corrupt {
                    key: head.into(),
                    reason: "bad head".into(),
                })?;
                Ok(Some((record, e_tag)))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }
}

#[async_trait]
impl MetaStore for ObjectMetaStore {
    async fn get(&self, head: &str) -> Result<Option<Head>> {
        check_head_name(head)?;
        Ok(self.read(head).await?.map(|(record, _)| record))
    }

    async fn cas(&self, head: &str, expected: Option<&Head>, new: Option<&Head>) -> Result<()> {
        check_head_name(head)?;
        let current = self.read(head).await?;
        let found = current.as_ref().map(|(record, _)| *record);
        if found.as_ref() != expected {
            return Err(conflict(head, expected, found.as_ref()));
        }
        let path = self.path(head);
        let Some(new) = new else {
            // Deleting can't be conditional on S3; heads are deleted only by their owner.
            return self.store.delete(&path).await.map_err(store_error);
        };
        let mode = match current {
            None => PutMode::Create,
            Some((_, e_tag)) => PutMode::Update(UpdateVersion {
                e_tag,
                version: None,
            }),
        };
        let options = PutOptions {
            mode,
            ..Default::default()
        };
        match self
            .store
            .put_opts(&path, PutPayload::from(new.encode()), options)
            .await
        {
            Ok(_) => Ok(()),
            Err(
                object_store::Error::AlreadyExists { .. }
                | object_store::Error::Precondition { .. },
            ) => {
                let found = self.read(head).await?.map(|(record, _)| record);
                Err(conflict(head, expected, found.as_ref()))
            }
            Err(e) => Err(store_error(e)),
        }
    }

    async fn list(&self) -> Result<Vec<(String, Head)>> {
        use futures::StreamExt;
        let prefix = Path::from(format!("{}/heads", self.prefix.trim_end_matches('/')));
        let mut stream = self.store.list(Some(&prefix));
        let mut heads = Vec::new();
        while let Some(meta) = stream.next().await {
            let meta = meta.map_err(store_error)?;
            let Some(name) = meta.location.filename() else {
                continue;
            };
            if let Some(record) = self.get(name).await? {
                heads.push((name.to_string(), record));
            }
        }
        heads.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(heads)
    }
}
