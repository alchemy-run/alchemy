//! Opening a volume store from a URL-like spec:
//!
//! - `local:/var/lib/volumes` — objects and heads under a directory
//! - `s3://bucket/prefix` — objects and heads in a bucket, credentials and
//!   endpoint from the standard `AWS_*` environment (set `AWS_ENDPOINT` for R2)

use anyhow::{Result, bail};
use std::sync::Arc;
use volume::Volume;
use volume::store::{LocalBlobStore, LocalMetaStore};

pub fn open(spec: &str) -> Result<Volume> {
    if let Some(dir) = spec.strip_prefix("local:") {
        let dir = std::path::Path::new(dir);
        return Ok(Volume::new(
            Arc::new(LocalBlobStore::new(dir.join("blobs"))?),
            Arc::new(LocalMetaStore::new(dir.join("heads"))?),
        ));
    }
    if let Some(rest) = spec.strip_prefix("s3://") {
        return open_s3(rest);
    }
    bail!("unknown store {spec:?}: use local:<dir> or s3://<bucket>/<prefix>")
}

#[cfg(feature = "object")]
fn open_s3(rest: &str) -> Result<Volume> {
    use object_store::aws::{AmazonS3Builder, S3ConditionalPut};
    use volume::store::{ObjectBlobStore, ObjectMetaStore};
    let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, "volumes"));
    let store: Arc<dyn object_store::ObjectStore> = Arc::new(
        AmazonS3Builder::from_env()
            .with_bucket_name(bucket)
            .with_conditional_put(S3ConditionalPut::ETagMatch)
            .build()?,
    );
    Ok(Volume::new(
        Arc::new(ObjectBlobStore::new(store.clone(), prefix)),
        Arc::new(ObjectMetaStore::new(store, prefix)),
    ))
}

#[cfg(not(feature = "object"))]
fn open_s3(_: &str) -> Result<Volume> {
    bail!("this build of blockd has no object store support (feature \"object\")")
}
