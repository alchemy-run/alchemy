//! Opening a volume store from a URL-like spec:
//!
//! - `local:/var/lib/volumes` — objects and heads under a directory
//! - `s3://bucket/prefix` — objects and heads in a bucket, credentials and
//!   endpoint from the standard `AWS_*` environment (set `AWS_ENDPOINT` for R2)
//!
//! `--heads <url>` keeps the objects in the store but reads and moves heads
//! through a coordinator over HTTP (`volume::store::HttpMetaStore`), and
//! `--journal <url>` keeps journal entries there too, appended and fenced in
//! one request (`volume::store::HttpJournalStore`). `BLOCKD_HEADS_TOKEN` is
//! the bearer token for both, if set.

use anyhow::{Result, bail};
use std::sync::Arc;
use volume::Volume;
use volume::store::{BlobStore, LocalBlobStore, LocalMetaStore, MetaStore};

pub fn open(spec: &str, heads: Option<&str>, journal: Option<&str>) -> Result<Volume> {
    let (blobs, meta): (Arc<dyn BlobStore>, Arc<dyn MetaStore>) =
        if let Some(dir) = spec.strip_prefix("local:") {
            let dir = std::path::Path::new(dir);
            (
                Arc::new(LocalBlobStore::new(dir.join("blobs"))?),
                Arc::new(LocalMetaStore::new(dir.join("heads"))?),
            )
        } else if let Some(rest) = spec.strip_prefix("s3://") {
            open_s3(rest)?
        } else {
            bail!("unknown store {spec:?}: use local:<dir> or s3://<bucket>/<prefix>")
        };
    let meta = match heads {
        Some(url) => http_heads(url)?,
        None => meta,
    };
    let volume = Volume::new(blobs, meta);
    Ok(match journal {
        Some(url) => volume.with_journal(http_journal(url)?),
        None => volume,
    })
}

/// Blocks per journal entry a coordinator holds: its values are capped
/// (a Durable Object's at 2 MiB), and compressed blocks stay well under.
const COORDINATOR_ENTRY_BLOCKS: usize = 256;

#[cfg(feature = "object")]
fn http_journal(url: &str) -> Result<Arc<dyn volume::store::JournalStore>> {
    let token = std::env::var("BLOCKD_HEADS_TOKEN").ok();
    Ok(Arc::new(volume::store::HttpJournalStore::new(
        url,
        token,
        COORDINATOR_ENTRY_BLOCKS,
    )))
}

#[cfg(not(feature = "object"))]
fn http_journal(_: &str) -> Result<Arc<dyn volume::store::JournalStore>> {
    bail!("this build of blockd has no HTTP journal (feature \"object\")")
}

#[cfg(feature = "object")]
fn http_heads(url: &str) -> Result<Arc<dyn MetaStore>> {
    let token = std::env::var("BLOCKD_HEADS_TOKEN").ok();
    Ok(Arc::new(volume::store::HttpMetaStore::new(url, token)))
}

#[cfg(not(feature = "object"))]
fn http_heads(_: &str) -> Result<Arc<dyn MetaStore>> {
    bail!("this build of blockd has no HTTP heads (feature \"object\")")
}

#[cfg(feature = "object")]
fn open_s3(rest: &str) -> Result<(Arc<dyn BlobStore>, Arc<dyn MetaStore>)> {
    use object_store::aws::{AmazonS3Builder, S3ConditionalPut};
    use volume::store::{ObjectBlobStore, ObjectMetaStore};
    let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, "volumes"));
    let store: Arc<dyn object_store::ObjectStore> = Arc::new(
        AmazonS3Builder::from_env()
            .with_bucket_name(bucket)
            .with_conditional_put(S3ConditionalPut::ETagMatch)
            .build()?,
    );
    Ok((
        Arc::new(ObjectBlobStore::new(store.clone(), prefix)),
        Arc::new(ObjectMetaStore::new(store, prefix)),
    ))
}

#[cfg(not(feature = "object"))]
fn open_s3(_: &str) -> Result<(Arc<dyn BlobStore>, Arc<dyn MetaStore>)> {
    bail!("this build of blockd has no object store support (feature \"object\")")
}
