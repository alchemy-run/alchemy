//! The S3-compatible store against a real bucket.
//!
//! Runs when `VOLUME_TEST_S3_URL=s3://<bucket>/<prefix>` is set, with the
//! usual `AWS_*` credentials (and `AWS_ENDPOINT` for R2). Each run uses its
//! own prefix.
#![cfg(feature = "object")]

use object_store::aws::{AmazonS3Builder, S3ConditionalPut};
use std::sync::Arc;
use volume::store::{BlobStore, MetaStore, ObjectBlobStore, ObjectMetaStore};
use volume::{Change, EXTENT_SIZE, Error, Hash, Volume};

fn bucket() -> Option<(Arc<dyn object_store::ObjectStore>, String)> {
    let url = std::env::var("VOLUME_TEST_S3_URL").ok()?;
    let rest = url
        .strip_prefix("s3://")
        .expect("VOLUME_TEST_S3_URL must be s3://bucket/prefix");
    let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, "volume-test"));
    let store = AmazonS3Builder::from_env()
        .with_bucket_name(bucket)
        .with_conditional_put(S3ConditionalPut::ETagMatch)
        .build()
        .expect("an S3 client");
    let run = format!(
        "{prefix}/run-{}-{}",
        std::process::id(),
        Hash::of(&nanos()).to_hex()[..8].to_owned()
    );
    Some((Arc::new(store), run))
}

fn nanos() -> [u8; 16] {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .to_le_bytes()
}

macro_rules! require_bucket {
    () => {
        match bucket() {
            Some(found) => found,
            None => {
                eprintln!("skipped: set VOLUME_TEST_S3_URL");
                return;
            }
        }
    };
}

#[tokio::test]
async fn blobs_round_trip_with_ranges_and_idempotent_puts() {
    let (store, prefix) = require_bucket!();
    let blobs = ObjectBlobStore::new(store, prefix);
    blobs.put("a/b", b"hello world".to_vec()).await.unwrap();
    blobs.put("a/b", b"hello world".to_vec()).await.unwrap(); // already there: fine
    assert_eq!(blobs.get("a/b").await.unwrap(), b"hello world");
    assert_eq!(blobs.get_range("a/b", 6, 11).await.unwrap(), b"world");
    assert!(blobs.exists("a/b").await.unwrap());
    assert!(!blobs.exists("a/missing").await.unwrap());
    assert!(matches!(
        blobs.get("a/missing").await,
        Err(Error::Missing(_))
    ));
}

#[tokio::test]
async fn heads_move_only_by_compare_and_set() {
    let (store, prefix) = require_bucket!();
    let meta = ObjectMetaStore::new(store, prefix);
    let (one, two) = (Hash::of(b"one"), Hash::of(b"two"));
    meta.cas("main", None, Some(one)).await.unwrap();
    assert!(matches!(
        meta.cas("main", None, Some(two)).await,
        Err(Error::Conflict { .. })
    ));
    assert!(matches!(
        meta.cas("main", Some(two), Some(one)).await,
        Err(Error::Conflict { .. })
    ));
    meta.cas("main", Some(one), Some(two)).await.unwrap();
    assert_eq!(meta.get("main").await.unwrap(), Some(two));
    assert_eq!(meta.list().await.unwrap(), vec![("main".to_string(), two)]);
    meta.cas("main", Some(two), None).await.unwrap();
    assert_eq!(meta.get("main").await.unwrap(), None);
}

#[tokio::test]
async fn concurrent_commits_on_one_head_let_exactly_one_win() {
    let (store, prefix) = require_bucket!();
    let volume = Arc::new(Volume::new(
        Arc::new(ObjectBlobStore::new(store.clone(), prefix.clone())),
        Arc::new(ObjectMetaStore::new(store, prefix)),
    ));
    let base = volume.create("main", 64 * 1024 * 1024).await.unwrap();
    let racers = (0..4u8).map(|i| {
        let volume = volume.clone();
        tokio::spawn(async move {
            volume
                .commit(
                    "main",
                    &base,
                    vec![(i as u64, Change::Write(vec![i + 1; EXTENT_SIZE as usize]))],
                )
                .await
        })
    });
    let results: Vec<_> = futures_join(racers).await;
    let wins = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(wins, 1, "exactly one commit moves the head: {results:?}");
    assert!(
        results
            .iter()
            .filter(|r| r.is_err())
            .all(|r| matches!(r, Err(Error::Conflict { .. })))
    );
}

#[tokio::test]
async fn a_volume_lives_in_the_bucket() {
    let (store, prefix) = require_bucket!();
    let open = || {
        Volume::new(
            Arc::new(ObjectBlobStore::new(store.clone(), prefix.clone())),
            Arc::new(ObjectMetaStore::new(store.clone(), prefix.clone())),
        )
    };
    let id = {
        let volume = open();
        let base = volume.create("main", 64 * 1024 * 1024).await.unwrap();
        let one = volume
            .commit(
                "main",
                &base,
                vec![(7, Change::Write(vec![7; EXTENT_SIZE as usize]))],
            )
            .await
            .unwrap();
        volume.fork("main", "fork").await.unwrap();
        volume
            .commit(
                "fork",
                &one,
                vec![(8, Change::Write(vec![8; EXTENT_SIZE as usize]))],
            )
            .await
            .unwrap()
    };
    let volume = open(); // a fresh process: nothing cached
    assert_eq!(volume.head("fork").await.unwrap(), id);
    assert_eq!(
        volume.read_extent(&id, 7).await.unwrap(),
        Some(vec![7; EXTENT_SIZE as usize])
    );
    assert_eq!(
        volume.read_extent(&id, 8).await.unwrap(),
        Some(vec![8; EXTENT_SIZE as usize])
    );
    let main = volume.head("main").await.unwrap();
    assert_eq!(volume.read_extent(&main, 8).await.unwrap(), None);
}

async fn futures_join<T>(handles: impl Iterator<Item = tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut out = Vec::new();
    for handle in handles {
        out.push(handle.await.unwrap());
    }
    out
}
