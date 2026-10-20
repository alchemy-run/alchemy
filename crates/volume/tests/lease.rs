//! Leases and the journal: what `fsync` guarantees, fencing, recovery, and a
//! seeded simulation of crashes and storage faults checked against a model.

use async_trait::async_trait;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use volume::journal;
use volume::store::{BlobMeta, BlobStore, Head, MemoryBlobStore, MemoryMetaStore, MetaStore};
use volume::{BLOCK_SIZE, Change, EXTENT_SIZE, Error, GcOptions, Hash, Result, Volume};

const BLOCKS_PER_EXTENT: u64 = EXTENT_SIZE / BLOCK_SIZE;
const SIZE: u64 = 2 * EXTENT_SIZE;
const BLOCKS: u64 = SIZE / BLOCK_SIZE;

fn block(byte: u8) -> Vec<u8> {
    vec![byte; BLOCK_SIZE as usize]
}

fn memory() -> (Volume, Arc<MemoryBlobStore>) {
    let blobs = Arc::new(MemoryBlobStore::new());
    (
        Volume::new(blobs.clone(), Arc::new(MemoryMetaStore::new())),
        blobs,
    )
}

/// Every block's first byte, checking each block is one repeated byte.
async fn read_disk(volume: &Volume, snapshot: &Hash) -> Vec<u8> {
    let mut out = Vec::with_capacity(BLOCKS as usize);
    for extent in 0..SIZE / EXTENT_SIZE {
        let bytes = volume
            .read_extent(snapshot, extent)
            .await
            .unwrap()
            .unwrap_or_else(|| vec![0; EXTENT_SIZE as usize]);
        for chunk in bytes.chunks(BLOCK_SIZE as usize) {
            assert!(chunk.iter().all(|&b| b == chunk[0]), "a torn block");
            out.push(chunk[0]);
        }
    }
    out
}

fn journal_keys(blobs: &MemoryBlobStore) -> Vec<String> {
    let mut keys: Vec<String> = blobs
        .keys()
        .into_iter()
        .filter(|k| k.starts_with("journal/"))
        .collect();
    keys.sort();
    keys
}

#[tokio::test]
async fn an_appended_block_survives_its_writer() {
    let (volume, _) = memory();
    let base = volume.create("main", SIZE).await.unwrap();
    let mut lease = volume.acquire("main").await.unwrap();
    assert_eq!(lease.snapshot(), base, "nothing to recover on a new head");
    volume
        .append(&mut lease, vec![(5, block(5))])
        .await
        .unwrap();
    drop(lease); // the machine dies

    let next = volume.acquire("main").await.unwrap();
    assert_ne!(
        next.snapshot(),
        base,
        "the journal was folded into a snapshot"
    );
    assert_eq!(read_disk(&volume, &next.snapshot()).await[5], 5);
    assert_eq!(
        volume.history(&next.snapshot(), 10).await.unwrap(),
        vec![next.snapshot(), base],
        "one snapshot for the crashed writer's journal"
    );
}

#[tokio::test]
async fn a_commit_folds_the_journal_and_deletes_it() {
    let (volume, blobs) = memory();
    volume.create("main", SIZE).await.unwrap();
    let mut lease = volume.acquire("main").await.unwrap();
    volume
        .append(&mut lease, vec![(1, block(1))])
        .await
        .unwrap();
    volume
        .append(&mut lease, vec![(2, block(2))])
        .await
        .unwrap();
    assert_eq!(lease.journaled(), 2);
    assert_eq!(journal_keys(&blobs).len(), 2);

    let mut extent = vec![0; EXTENT_SIZE as usize];
    extent[BLOCK_SIZE as usize..2 * BLOCK_SIZE as usize].fill(1);
    extent[2 * BLOCK_SIZE as usize..3 * BLOCK_SIZE as usize].fill(2);
    let snapshot = volume
        .commit_leased(&mut lease, vec![(0, Change::Write(extent))])
        .await
        .unwrap();
    assert_eq!(lease.journaled(), 0);
    assert!(
        journal_keys(&blobs).is_empty(),
        "folded entries are deleted"
    );

    // The next lease has nothing to fold: no extra snapshot.
    let next = volume.acquire("main").await.unwrap();
    assert_eq!(next.snapshot(), snapshot);
}

#[tokio::test]
async fn a_new_lease_fences_the_old_writer() {
    let (volume, _) = memory();
    volume.create("main", SIZE).await.unwrap();
    let mut old = volume.acquire("main").await.unwrap();
    volume.append(&mut old, vec![(1, block(1))]).await.unwrap();

    let new = volume.acquire("main").await.unwrap();
    assert!(new.epoch() > old.epoch());
    assert!(matches!(
        volume.append(&mut old, vec![(2, block(2))]).await,
        Err(Error::Fenced(_))
    ));
    assert!(matches!(
        volume
            .commit_leased(
                &mut old,
                vec![(0, Change::Write(vec![9; EXTENT_SIZE as usize]))]
            )
            .await,
        Err(Error::Fenced(_))
    ));
    let disk = read_disk(&volume, &volume.head("main").await.unwrap()).await;
    assert_eq!(
        (disk[1], disk[2], disk[0]),
        (1, 0, 0),
        "only what was durable before the fence"
    );
}

#[tokio::test]
async fn entries_after_a_gap_are_never_applied() {
    let (volume, blobs) = memory();
    let base = volume.create("main", SIZE).await.unwrap();
    let lease = volume.acquire("main").await.unwrap();
    // Entry 1 landed but entry 0 never did: 1 was never acknowledged.
    let late = vec![(7, block(7))];
    let key = journal::key("main", lease.epoch(), 1);
    blobs
        .put_new(&key, journal::encode(&late, lease.epoch(), 1).unwrap())
        .await
        .unwrap();
    drop(lease);

    let next = volume.acquire("main").await.unwrap();
    assert_eq!(next.snapshot(), base);
    assert_eq!(read_disk(&volume, &next.snapshot()).await[7], 0);
}

#[tokio::test]
async fn a_reset_fences_the_writer_and_drops_its_journal() {
    let (volume, _) = memory();
    let base = volume.create("main", SIZE).await.unwrap();
    let mut lease = volume.acquire("main").await.unwrap();
    volume
        .append(&mut lease, vec![(3, block(3))])
        .await
        .unwrap();
    volume.reset("main", base).await.unwrap();
    assert!(matches!(
        volume.append(&mut lease, vec![(4, block(4))]).await,
        Err(Error::Fenced(_))
    ));
    let next = volume.acquire("main").await.unwrap();
    assert_eq!(next.snapshot(), base, "the dropped journal isn't folded");
}

#[tokio::test]
async fn a_head_created_again_never_reuses_an_epoch() {
    let (volume, blobs) = memory();
    let base = volume.create("main", SIZE).await.unwrap();
    let mut old = volume.acquire("main").await.unwrap();
    volume.append(&mut old, vec![(1, block(1))]).await.unwrap();
    volume.drop_head("main").await.unwrap();
    assert!(matches!(
        volume.append(&mut old, vec![(2, block(2))]).await,
        Err(Error::Fenced(_))
    ));

    volume.fork_at(base, "main").await.unwrap();
    let new = volume.acquire("main").await.unwrap();
    assert!(
        new.epoch() > old.epoch(),
        "epochs continue past the tombstone"
    );
    assert_eq!(new.snapshot(), base, "the old head's journal isn't folded");
    assert!(
        !journal_keys(&blobs).is_empty(),
        "it's garbage, left for collection"
    );
    let options = GcOptions {
        grace: std::time::Duration::ZERO,
        ..Default::default()
    };
    volume.gc(&options).await.unwrap();
    assert!(journal_keys(&blobs).is_empty());
    assert_eq!(volume.heads().await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_lease_that_dies_recovering_is_finished_by_the_next() {
    let blobs = Arc::new(MemoryBlobStore::new());
    let faulty = Arc::new(Faulty::new(
        blobs.clone(),
        Arc::new(MemoryMetaStore::new()),
        0,
    ));
    let volume = Volume::new(faulty.clone(), faulty.clone());
    volume.create("main", SIZE).await.unwrap();
    let mut first = volume.acquire("main").await.unwrap();
    volume
        .append(&mut first, vec![(9, block(9))])
        .await
        .unwrap();

    // The second lease bumps the epoch, then dies before it moves the head.
    faulty.fail_cas_in.store(2, Ordering::SeqCst);
    assert!(volume.acquire("main").await.is_err());
    assert!(volume.record("main").await.unwrap().pending.is_some());

    let third = volume.acquire("main").await.unwrap();
    assert_eq!(read_disk(&volume, &third.snapshot()).await[9], 9);
    assert_eq!(volume.record("main").await.unwrap().pending, None);
}

#[tokio::test]
async fn garbage_collection_keeps_unfolded_journal_entries() {
    let (volume, blobs) = memory();
    volume.create("main", SIZE).await.unwrap();
    let mut lease = volume.acquire("main").await.unwrap();
    volume
        .append(&mut lease, vec![(1, block(1))])
        .await
        .unwrap();
    // A folded entry the writer failed to delete.
    let stale = journal::key("main", 0, 0);
    blobs
        .put_new(&stale, journal::encode(&vec![(2, block(2))], 0, 0).unwrap())
        .await
        .unwrap();
    let options = GcOptions {
        grace: std::time::Duration::ZERO,
        ..Default::default()
    };
    let report = volume.gc(&options).await.unwrap();
    assert_eq!(report.journal_deleted, 1);
    assert_eq!(journal_keys(&blobs), vec![journal::key("main", 1, 0)]);

    drop(lease);
    let next = volume.acquire("main").await.unwrap();
    assert_eq!(read_disk(&volume, &next.snapshot()).await[1], 1);
}

// ── simulation ─────────────────────────────────────────────────────────

/// xorshift64*: deterministic, and enough for choosing operations.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

/// A store whose requests fail at a seeded rate: before doing anything,
/// after doing it with the response lost, or done twice because a client
/// retried internally (a conditional write then reports its own success as
/// a conflict).
struct Faulty {
    blobs: Arc<MemoryBlobStore>,
    meta: Arc<MemoryMetaStore>,
    rng: Mutex<Rng>,
    percent: AtomicU64,
    /// Fails the n-th compare-and-set from now (0: never).
    fail_cas_in: AtomicU64,
}

enum Fate {
    Ok,
    FailBefore,
    LoseResponse,
    Retried,
}

impl Faulty {
    fn new(blobs: Arc<MemoryBlobStore>, meta: Arc<MemoryMetaStore>, seed: u64) -> Self {
        Self {
            blobs,
            meta,
            rng: Mutex::new(Rng(seed | 1)),
            percent: AtomicU64::new(0),
            fail_cas_in: AtomicU64::new(0),
        }
    }

    fn fate(&self) -> Fate {
        let percent = self.percent.load(Ordering::SeqCst);
        let mut rng = self.rng.lock().unwrap();
        if percent == 0 || !rng.chance(percent) {
            return Fate::Ok;
        }
        match rng.below(3) {
            0 => Fate::FailBefore,
            1 => Fate::LoseResponse,
            _ => Fate::Retried,
        }
    }
}

fn fault() -> Error {
    Error::Store("injected fault".into())
}

/// Runs `op` according to `fate`.
async fn with_fate<T, F: std::future::Future<Output = Result<T>>>(
    fate: Fate,
    op: impl Fn() -> F,
) -> Result<T> {
    match fate {
        Fate::Ok => op().await,
        Fate::FailBefore => Err(fault()),
        Fate::LoseResponse => {
            op().await?;
            Err(fault())
        }
        Fate::Retried => {
            let _ = op().await;
            op().await
        }
    }
}

#[async_trait]
impl BlobStore for Faulty {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        with_fate(self.fate(), || self.blobs.put(key, bytes.clone())).await
    }
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        with_fate(self.fate(), || self.blobs.put_new(key, bytes.clone())).await
    }
    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        with_fate(self.fate(), || self.blobs.get(key)).await
    }
    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>> {
        with_fate(self.fate(), || self.blobs.get_range(key, start, end)).await
    }
    async fn exists(&self, key: &str) -> Result<bool> {
        with_fate(self.fate(), || self.blobs.exists(key)).await
    }
    async fn list(&self, prefix: &str) -> Result<Vec<BlobMeta>> {
        with_fate(self.fate(), || self.blobs.list(prefix)).await
    }
    async fn delete(&self, key: &str) -> Result<()> {
        with_fate(self.fate(), || self.blobs.delete(key)).await
    }
}

#[async_trait]
impl MetaStore for Faulty {
    async fn get(&self, head: &str) -> Result<Option<Head>> {
        with_fate(self.fate(), || self.meta.get(head)).await
    }
    async fn cas(&self, head: &str, expected: Option<&Head>, new: Option<&Head>) -> Result<()> {
        let countdown = self.fail_cas_in.load(Ordering::SeqCst);
        if countdown > 0 {
            self.fail_cas_in.store(countdown - 1, Ordering::SeqCst);
            if countdown == 1 {
                return Err(fault());
            }
        }
        with_fate(self.fate(), || self.meta.cas(head, expected, new)).await
    }
    async fn list(&self) -> Result<Vec<(String, Head)>> {
        with_fate(self.fate(), || self.meta.list()).await
    }
}

/// One writer as a machine runs it: a cache of the disk, the blocks not yet
/// journaled, and the extents not yet snapshotted.
struct Writer {
    lease: volume::Lease,
    cache: Vec<u8>,
    unjournaled: BTreeSet<u64>,
    unsnapshotted: BTreeSet<u64>,
}

/// Runs `ops` random operations under seed `seed`, crashing the writer at
/// random and on every failed request, and checks after every recovery
/// that the disk is a state the writer could have left: everything
/// acknowledged, plus possibly the one operation whose fate was unknown.
async fn simulate(seed: u64, ops: usize) {
    let blobs = Arc::new(MemoryBlobStore::new());
    let faulty = Arc::new(Faulty::new(blobs, Arc::new(MemoryMetaStore::new()), seed));
    let volume = Volume::new(faulty.clone(), faulty.clone());
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    volume.create("main", SIZE).await.unwrap();

    // What must survive, and the states a crash right now may also leave.
    let mut durable = vec![0u8; BLOCKS as usize];
    let mut maybe: Vec<Vec<u8>> = Vec::new();
    let mut writer: Option<Writer> = None;
    // A writer another attach superseded while it was still running.
    let mut zombie: Option<Writer> = None;
    let mut recoveries = 0;

    for op in 0..ops {
        faulty.percent.store(10, Ordering::SeqCst);
        // The superseded writer keeps going, and must get nowhere (once the
        // new writer has attached).
        if let Some(z) = zombie.as_mut()
            && writer.is_some()
            && rng.chance(20)
        {
            let b = rng.below(BLOCKS);
            let result = if rng.chance(70) {
                volume.append(&mut z.lease, vec![(b, block(0xEE))]).await
            } else {
                let changes = vec![(
                    b / BLOCKS_PER_EXTENT,
                    Change::Write(vec![0xEE; EXTENT_SIZE as usize]),
                )];
                volume
                    .commit_leased(&mut z.lease, changes)
                    .await
                    .map(|_| ())
            };
            match result {
                Err(Error::Fenced(_) | Error::Store(_)) => {}
                other => panic!("seed {seed} op {op}: a superseded writer wrote: {other:?}"),
            }
        }
        let Some(w) = writer.as_mut() else {
            // Attach: recover and check, retrying through faults.
            let lease = loop {
                match volume.acquire("main").await {
                    Ok(lease) => break lease,
                    Err(Error::Store(_)) => continue,
                    Err(e) => panic!("seed {seed} op {op}: acquire failed: {e}"),
                }
            };
            faulty.percent.store(0, Ordering::SeqCst);
            let disk = read_disk(&volume, &lease.snapshot()).await;
            assert!(
                disk == durable || maybe.contains(&disk),
                "seed {seed} op {op}: recovered a state no crash could leave"
            );
            durable = disk.clone();
            maybe.clear();
            recoveries += 1;
            writer = Some(Writer {
                lease,
                cache: disk,
                unjournaled: BTreeSet::new(),
                unsnapshotted: BTreeSet::new(),
            });
            continue;
        };

        let crash = match rng.below(100) {
            // write a block
            0..=54 => {
                let b = rng.below(BLOCKS);
                let value = 1 + rng.below(255) as u8;
                w.cache[b as usize] = value;
                w.unjournaled.insert(b);
                w.unsnapshotted.insert(b / BLOCKS_PER_EXTENT);
                false
            }
            // fsync
            55..=79 => {
                let blocks: Vec<(u64, Vec<u8>)> = w
                    .unjournaled
                    .iter()
                    .map(|&b| (b, block(w.cache[b as usize])))
                    .collect();
                let mut after = durable.clone();
                for &b in &w.unjournaled {
                    after[b as usize] = w.cache[b as usize];
                }
                let mut result = volume.append(&mut w.lease, blocks.clone()).await;
                if result.is_err() && rng.chance(50) {
                    result = volume.append(&mut w.lease, blocks).await; // retry once
                }
                match result {
                    Ok(()) => {
                        durable = after;
                        w.unjournaled.clear();
                        false
                    }
                    Err(Error::Store(_)) => {
                        maybe.push(after);
                        true
                    }
                    Err(e) => panic!("seed {seed} op {op}: append failed: {e}"),
                }
            }
            // the open ends: snapshot
            80..=89 => {
                let changes: Vec<(u64, Change)> = w
                    .unsnapshotted
                    .iter()
                    .map(|&e| {
                        let mut bytes = Vec::with_capacity(EXTENT_SIZE as usize);
                        for b in e * BLOCKS_PER_EXTENT..(e + 1) * BLOCKS_PER_EXTENT {
                            bytes.extend(block(w.cache[b as usize]));
                        }
                        (e, Change::Write(bytes))
                    })
                    .collect();
                match volume.commit_leased(&mut w.lease, changes).await {
                    Ok(_) => {
                        durable = w.cache.clone();
                        w.unjournaled.clear();
                        w.unsnapshotted.clear();
                        false
                    }
                    Err(Error::Store(_)) => {
                        maybe.push(w.cache.clone());
                        true
                    }
                    Err(e) => panic!("seed {seed} op {op}: commit failed: {e}"),
                }
            }
            // garbage collection, between anything
            90..=93 => {
                faulty.percent.store(0, Ordering::SeqCst);
                let options = GcOptions {
                    grace: std::time::Duration::ZERO,
                    ..Default::default()
                };
                volume.gc(&options).await.unwrap();
                false
            }
            // another machine attaches while this one still runs
            94..=95 => {
                zombie = writer.take();
                true
            }
            // the machine dies
            _ => true,
        };
        if crash {
            writer = None;
        }
    }
    assert!(recoveries > 1, "seed {seed}: the simulation never crashed");
}

#[tokio::test]
async fn simulated_crashes_and_faults_never_lose_an_acknowledged_write() {
    let seeds: u64 = std::env::var("VOLUME_SIM_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    for seed in 1..=seeds {
        simulate(seed, 300).await;
    }
}

#[test]
fn the_simulation_is_deterministic() {
    // Same seed, same store contents: replaying a failing seed reproduces it.
    let run = |seed| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let blobs = Arc::new(MemoryBlobStore::new());
            let faulty = Arc::new(Faulty::new(
                blobs.clone(),
                Arc::new(MemoryMetaStore::new()),
                seed,
            ));
            faulty.percent.store(10, Ordering::SeqCst);
            let volume = Volume::new(faulty.clone(), faulty);
            let mut outcomes = Vec::new();
            for _ in 0..50 {
                outcomes.push(volume.create("main", SIZE).await.is_ok());
            }
            let keys: BTreeMap<String, ()> = blobs.keys().into_iter().map(|k| (k, ())).collect();
            (outcomes, keys.into_keys().collect::<Vec<_>>())
        })
    };
    assert_eq!(run(7), run(7));
}
