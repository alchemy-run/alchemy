//! The S3-compatible store against a real bucket.
//!
//! Runs when `VOLUME_TEST_S3_URL=s3://<bucket>/<prefix>` is set, with the
//! usual `AWS_*` credentials (and `AWS_ENDPOINT` for R2). Each run uses its
//! own prefix.
#![cfg(feature = "object")]

use object_store::aws::{AmazonS3Builder, S3ConditionalPut};
use std::sync::Arc;
use volume::store::{BlobStore, Head, MetaStore, ObjectBlobStore, ObjectMetaStore};
use volume::{BLOCK_SIZE, Change, EXTENT_SIZE, Error, Hash, Volume};

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
    let one = Head::new(Hash::of(b"one"));
    let two = Head {
        epoch: 1,
        ..Head::new(Hash::of(b"two"))
    };
    meta.cas("main", None, Some(&one)).await.unwrap();
    assert!(matches!(
        meta.cas("main", None, Some(&two)).await,
        Err(Error::Conflict { .. })
    ));
    assert!(matches!(
        meta.cas("main", Some(&two), Some(&one)).await,
        Err(Error::Conflict { .. })
    ));
    meta.cas("main", Some(&one), Some(&two)).await.unwrap();
    assert_eq!(meta.get("main").await.unwrap(), Some(two));
    assert_eq!(meta.list().await.unwrap(), vec![("main".to_string(), two)]);
    meta.cas("main", Some(&two), None).await.unwrap();
    assert_eq!(meta.get("main").await.unwrap(), None);
}

#[tokio::test]
async fn put_new_writes_a_key_once() {
    let (store, prefix) = require_bucket!();
    let blobs = ObjectBlobStore::new(store, prefix);
    assert!(blobs.put_new("j/0", b"first".to_vec()).await.unwrap());
    assert!(!blobs.put_new("j/0", b"second".to_vec()).await.unwrap());
    assert_eq!(blobs.get("j/0").await.unwrap(), b"first");
}

#[tokio::test]
async fn a_new_lease_fences_the_old_writer_in_the_bucket() {
    let (store, prefix) = require_bucket!();
    let volume = Volume::new(
        Arc::new(ObjectBlobStore::new(store.clone(), prefix.clone())),
        Arc::new(ObjectMetaStore::new(store, prefix)),
    );
    volume.create("main", 64 * 1024 * 1024).await.unwrap();
    let block = |byte: u8| vec![byte; BLOCK_SIZE as usize];
    let mut old = volume.acquire("main").await.unwrap();
    volume.append(&mut old, vec![(3, block(3))]).await.unwrap();
    let new = volume.acquire("main").await.unwrap();
    assert!(matches!(
        volume.append(&mut old, vec![(4, block(4))]).await,
        Err(Error::Fenced(_))
    ));
    let extent = volume
        .read_extent(&new.snapshot(), 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        &extent[3 * BLOCK_SIZE as usize..4 * BLOCK_SIZE as usize],
        &block(3)[..]
    );
    assert!(
        extent[4 * BLOCK_SIZE as usize..5 * BLOCK_SIZE as usize]
            .iter()
            .all(|&b| b == 0)
    );
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

/// How long an `fsync` (one journal append) and a snapshot take against the
/// bucket. Run with `--ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn measure_sync_and_snapshot_latency() {
    let (store, prefix) = require_bucket!();
    let volume = Volume::new(
        Arc::new(ObjectBlobStore::new(store.clone(), prefix.clone())),
        Arc::new(ObjectMetaStore::new(store, prefix)),
    );
    volume.create("main", 64 * 1024 * 1024).await.unwrap();
    let mut lease = volume.acquire("main").await.unwrap();
    let percentiles = |mut samples: Vec<std::time::Duration>| {
        samples.sort();
        let at = |p: usize| samples[(samples.len() - 1) * p / 100].as_millis();
        format!("p50 {}ms, p90 {}ms, max {}ms", at(50), at(90), at(100))
    };
    for blocks in [1u64, 64, 1024] {
        let mut samples = Vec::new();
        for round in 0..20u64 {
            let batch = (0..blocks)
                .map(|b| (b, vec![(round + 1) as u8; BLOCK_SIZE as usize]))
                .collect();
            let started = std::time::Instant::now();
            volume.append(&mut lease, batch).await.unwrap();
            samples.push(started.elapsed());
        }
        eprintln!("sync of {blocks} blocks: {}", percentiles(samples));
    }
    let mut samples = Vec::new();
    for round in 0..10u8 {
        let changes = (0..4)
            .map(|e| (e, Change::Write(vec![round + 1; EXTENT_SIZE as usize])))
            .collect();
        let started = std::time::Instant::now();
        volume.commit_leased(&mut lease, changes).await.unwrap();
        samples.push(started.elapsed());
    }
    eprintln!("snapshot of 4 extents: {}", percentiles(samples));
    let started = std::time::Instant::now();
    let _ = volume.acquire("main").await.unwrap();
    eprintln!("acquire with nothing to fold: {}ms", started.elapsed().as_millis());
}
