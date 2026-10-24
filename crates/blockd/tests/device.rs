//! The block layer, without a kernel: a second `Device` on the same store
//! plays "another machine attaching the volume".

use blockd::Device;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::runtime::Runtime;
use volume::store::{LocalBlobStore, LocalMetaStore};
use volume::{BLOCK_SIZE, EXTENT_SIZE, Volume};

const MIB: u64 = 1024 * 1024;

struct World {
    dir: TempDir,
    runtime: Runtime,
    volume: Arc<Volume>,
    caches: std::cell::Cell<u32>,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let volume = Arc::new(Volume::new(
            Arc::new(LocalBlobStore::new(dir.path().join("blobs")).unwrap()),
            Arc::new(LocalMetaStore::new(dir.path().join("heads")).unwrap()),
        ));
        Self {
            dir,
            runtime: Runtime::new().unwrap(),
            volume,
            caches: Default::default(),
        }
    }

    /// A base image with a recognizable pattern in its first 4 MiB.
    fn base(&self, head: &str) {
        let image: Vec<u8> = (0..4 * MIB)
            .map(|i| (i / BLOCK_SIZE % 251) as u8 + 1)
            .collect();
        self.runtime
            .block_on(self.volume.import(head, 64 * MIB, image.as_slice()))
            .unwrap();
    }

    /// Attaches `head` with a fresh cache: a new machine.
    fn attach(&self, head: &str) -> Device {
        let n = self.caches.get() + 1;
        self.caches.set(n);
        self.attach_at(head, &format!("cache-{n}"))
    }

    /// Attaches `head` with the named cache: the same machine again.
    fn attach_at(&self, head: &str, cache: &str) -> Device {
        let cache = self.dir.path().join(cache);
        Device::open(
            self.volume.clone(),
            head,
            &cache,
            self.runtime.handle().clone(),
        )
        .unwrap()
    }

    fn head(&self, head: &str) -> volume::Hash {
        self.runtime.block_on(self.volume.head(head)).unwrap()
    }
}

fn pattern(block: u64) -> u8 {
    (block % 251) as u8 + 1
}

#[test]
fn reads_fetch_lazily_and_only_once() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    assert_eq!(
        device.status().present_blocks,
        0,
        "nothing is fetched at attach"
    );

    let block = device.read(5 * BLOCK_SIZE, BLOCK_SIZE as u32).unwrap();
    assert!(block.iter().all(|&b| b == pattern(5)));
    assert_eq!(device.status().fetches, 1);
    assert_eq!(
        device.status().present_blocks,
        EXTENT_SIZE / BLOCK_SIZE,
        "the whole extent arrived"
    );

    device
        .read(6 * BLOCK_SIZE, (2 * BLOCK_SIZE) as u32)
        .unwrap(); // same extent
    assert_eq!(device.status().fetches, 1);

    let empty = device.read(32 * MIB, BLOCK_SIZE as u32).unwrap(); // never written
    assert!(empty.iter().all(|&b| b == 0));
}

#[test]
fn a_snapshot_is_seen_by_the_next_machine() {
    let world = World::new();
    world.base("base");
    let first = world.attach("base");
    first
        .write(10 * MIB, &vec![0xAB; (3 * BLOCK_SIZE) as usize])
        .unwrap();
    let snapshot = first.snapshot().unwrap();
    assert_eq!(
        world.runtime.block_on(world.volume.head("base")).unwrap(),
        snapshot
    );

    let second = world.attach("base");
    let read = second
        .read(10 * MIB - BLOCK_SIZE, (5 * BLOCK_SIZE) as u32)
        .unwrap();
    let blocks: Vec<&[u8]> = read.chunks(BLOCK_SIZE as usize).collect();
    assert!(blocks[0].iter().all(|&b| b == 0));
    assert!(
        blocks[1..4]
            .iter()
            .all(|block| block.iter().all(|&b| b == 0xAB))
    );
    assert!(blocks[4].iter().all(|&b| b == 0));
}

#[test]
fn a_write_into_an_unread_extent_keeps_the_rest_of_it() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    // block 3 of extent 0 is overwritten without the extent ever being read
    device
        .write(3 * BLOCK_SIZE, &vec![0xEE; BLOCK_SIZE as usize])
        .unwrap();
    device.snapshot().unwrap();

    let fresh = world.attach("base");
    let extent = fresh.read(0, EXTENT_SIZE as u32).unwrap();
    for (block, bytes) in extent.chunks(BLOCK_SIZE as usize).enumerate() {
        let expected = if block == 3 {
            0xEE
        } else {
            pattern(block as u64)
        };
        assert!(bytes.iter().all(|&b| b == expected), "block {block}");
    }
}

#[test]
fn a_partial_block_write_keeps_the_rest_of_the_block() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.write(BLOCK_SIZE + 100, b"hello").unwrap();
    let block = device.read(BLOCK_SIZE, BLOCK_SIZE as u32).unwrap();
    assert_eq!(&block[100..105], b"hello");
    assert!(
        block[..100]
            .iter()
            .chain(&block[105..])
            .all(|&b| b == pattern(1))
    );
}

#[test]
fn a_fork_is_frozen_while_the_original_keeps_writing() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.write(0, &vec![1; BLOCK_SIZE as usize]).unwrap();
    let forked = device.fork("try-1").unwrap();
    device.write(0, &vec![2; BLOCK_SIZE as usize]).unwrap();
    device.snapshot().unwrap();

    assert_eq!(
        world.runtime.block_on(world.volume.head("try-1")).unwrap(),
        forked
    );
    let fork = world.attach("try-1");
    assert!(
        fork.read(0, BLOCK_SIZE as u32)
            .unwrap()
            .iter()
            .all(|&b| b == 1)
    );
    let main = world.attach("base");
    assert!(
        main.read(0, BLOCK_SIZE as u32)
            .unwrap()
            .iter()
            .all(|&b| b == 2)
    );
}

#[test]
fn a_snapshot_with_nothing_dirty_writes_nothing() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.read(0, BLOCK_SIZE as u32).unwrap();
    let before = device.status().base;
    assert_eq!(device.snapshot().unwrap(), before);
    assert_eq!(device.status().flushes, 0);
}

#[test]
fn zeroing_a_range_reads_as_zeros_everywhere() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.zero(0, EXTENT_SIZE).unwrap();
    device.snapshot().unwrap();
    let fresh = world.attach("base");
    assert!(
        fresh
            .read(0, EXTENT_SIZE as u32)
            .unwrap()
            .iter()
            .all(|&b| b == 0)
    );
    let head = world.runtime.block_on(world.volume.head("base")).unwrap();
    assert_eq!(
        world
            .runtime
            .block_on(world.volume.read_extent(&head, 0))
            .unwrap(),
        None,
        "a zero extent isn't stored"
    );
}

#[test]
fn every_snapshot_is_a_point_to_rewind_to() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    let mut snapshots = Vec::new();
    for step in 1..=3u8 {
        device.write(0, &vec![step; BLOCK_SIZE as usize]).unwrap();
        snapshots.push(device.snapshot().unwrap());
    }
    drop(device);
    world
        .runtime
        .block_on(world.volume.reset("base", snapshots[0]))
        .unwrap();
    let rewound = world.attach("base");
    assert!(
        rewound
            .read(0, BLOCK_SIZE as u32)
            .unwrap()
            .iter()
            .all(|&b| b == 1)
    );
}

#[test]
fn out_of_range_requests_fail() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    assert!(
        device
            .read(64 * MIB - BLOCK_SIZE, (2 * BLOCK_SIZE) as u32)
            .is_err()
    );
    assert!(device.write(64 * MIB, b"x").is_err());
}

#[test]
fn a_clean_close_leaves_a_warm_cache() {
    let world = World::new();
    world.base("base");
    let device = world.attach_at("base", "machine");
    device.read(0, (4 * MIB) as u32).unwrap();
    let fetched = device.status().fetches;
    assert_eq!(fetched, 16);
    device.close().unwrap();
    drop(device);

    let again = world.attach_at("base", "machine");
    assert_eq!(again.status().reused_blocks, 4 * MIB / BLOCK_SIZE);
    let bytes = again.read(0, (4 * MIB) as u32).unwrap();
    assert_eq!(
        again.status().fetches,
        0,
        "everything came from the warm cache"
    );
    assert!(
        bytes[..BLOCK_SIZE as usize]
            .iter()
            .all(|&b| b == pattern(0))
    );
}

#[test]
fn a_warm_cache_drops_only_what_another_machine_changed() {
    let world = World::new();
    world.base("base");
    let mine = world.attach_at("base", "mine");
    mine.read(0, (4 * MIB) as u32).unwrap();
    mine.close().unwrap();
    drop(mine);

    // another machine changes one extent and moves the head
    let theirs = world.attach_at("base", "theirs");
    theirs
        .write(EXTENT_SIZE * 5, &vec![0x55; BLOCK_SIZE as usize])
        .unwrap();
    theirs.close().unwrap();
    drop(theirs);

    let mine = world.attach_at("base", "mine");
    let bytes = mine.read(0, (4 * MIB) as u32).unwrap();
    assert_eq!(
        mine.status().fetches,
        1,
        "only the changed extent is fetched again"
    );
    let at = (EXTENT_SIZE * 5) as usize;
    assert!(
        bytes[at..at + BLOCK_SIZE as usize]
            .iter()
            .all(|&b| b == 0x55)
    );
}

#[test]
fn a_crash_leaves_no_warm_cache_and_only_durable_writes() {
    let world = World::new();
    world.base("base");
    let device = world.attach_at("base", "machine");
    device.write(0, &vec![1; BLOCK_SIZE as usize]).unwrap();
    device.snapshot().unwrap();
    device
        .write(BLOCK_SIZE, &vec![2; BLOCK_SIZE as usize])
        .unwrap(); // never synced
    drop(device); // crash: no close

    let again = world.attach_at("base", "machine");
    assert_eq!(
        again.status().reused_blocks,
        0,
        "a crashed cache isn't trusted"
    );
    let bytes = again.read(0, (2 * BLOCK_SIZE) as u32).unwrap();
    assert!(bytes[..BLOCK_SIZE as usize].iter().all(|&b| b == 1));
    assert!(
        bytes[BLOCK_SIZE as usize..]
            .iter()
            .all(|&b| b == pattern(1))
    );
}

#[test]
fn the_background_flusher_journals_without_being_asked() {
    let world = World::new();
    world.base("base");
    let device = Arc::new(world.attach("base"));
    let before = world.head("base");
    let _flusher = device.start_flusher(std::time::Duration::from_millis(50));
    device.write(0, &vec![9; BLOCK_SIZE as usize]).unwrap();
    for _ in 0..100 {
        if device.status().unjournaled_blocks == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(device.status().unjournaled_blocks, 0);
    assert_eq!(world.head("base"), before, "journaling doesn't snapshot");
    assert_eq!(
        device.status().dirty_blocks,
        1,
        "the snapshot is still to come"
    );
}

#[test]
fn a_synced_write_survives_a_crash_as_one_snapshot() {
    let world = World::new();
    world.base("base");
    let before = world.head("base");
    let device = world.attach("base");
    device.write(0, &vec![1; BLOCK_SIZE as usize]).unwrap();
    device.sync().unwrap();
    device
        .write(BLOCK_SIZE, &vec![2; BLOCK_SIZE as usize])
        .unwrap();
    device.sync().unwrap();
    assert_eq!(world.head("base"), before, "syncs don't snapshot");
    drop(device); // crash: no close, no snapshot

    let again = world.attach("base");
    let bytes = again.read(0, (2 * BLOCK_SIZE) as u32).unwrap();
    assert!(bytes[..BLOCK_SIZE as usize].iter().all(|&b| b == 1));
    assert!(bytes[BLOCK_SIZE as usize..].iter().all(|&b| b == 2));
    let after = world.head("base");
    assert_eq!(
        world
            .runtime
            .block_on(world.volume.history(&after, 10))
            .unwrap(),
        vec![after, before],
        "both syncs fold into one snapshot"
    );
}

#[test]
fn a_sync_with_nothing_new_writes_nothing() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.write(0, &vec![1; BLOCK_SIZE as usize]).unwrap();
    device.sync().unwrap();
    device.sync().unwrap();
    assert_eq!(device.status().syncs, 1);
}

#[test]
fn concurrent_syncs_lose_nothing() {
    let world = World::new();
    world.base("base");
    let device = Arc::new(world.attach("base"));
    let threads: Vec<_> = (0..8u64)
        .map(|i| {
            let device = device.clone();
            std::thread::spawn(move || {
                for round in 0..10u64 {
                    let block = i * 10 + round;
                    device
                        .write(
                            block * BLOCK_SIZE,
                            &vec![(i + 1) as u8; BLOCK_SIZE as usize],
                        )
                        .unwrap();
                    device.sync().unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert!(device.status().syncs <= 80);
    drop(device); // crash

    let again = world.attach("base");
    let bytes = again.read(0, (80 * BLOCK_SIZE) as u32).unwrap();
    for (block, data) in bytes.chunks(BLOCK_SIZE as usize).enumerate() {
        let expected = (block as u64 / 10 + 1) as u8;
        assert!(data.iter().all(|&b| b == expected), "block {block}");
    }
}

#[test]
fn attaching_elsewhere_fences_this_device() {
    let world = World::new();
    world.base("base");
    let old = world.attach("base");
    old.write(0, &vec![1; BLOCK_SIZE as usize]).unwrap();
    old.sync().unwrap();

    let new = world.attach("base");
    old.write(BLOCK_SIZE, &vec![2; BLOCK_SIZE as usize])
        .unwrap(); // local only
    assert!(old.sync().is_err(), "the old device can't make it durable");
    assert!(
        old.write(0, b"x").is_err(),
        "and refuses writes from then on"
    );
    assert!(old.snapshot().is_err());

    let bytes = new.read(0, (2 * BLOCK_SIZE) as u32).unwrap();
    assert!(bytes[..BLOCK_SIZE as usize].iter().all(|&b| b == 1));
    assert!(
        bytes[BLOCK_SIZE as usize..]
            .iter()
            .all(|&b| b == pattern(1))
    );
}

#[test]
fn writes_during_a_snapshot_are_kept_for_the_next_one() {
    let world = World::new();
    world.base("base");
    let device = Arc::new(world.attach("base"));
    let writer = {
        let device = device.clone();
        std::thread::spawn(move || {
            for round in 0..200u64 {
                let byte = (round % 250) as u8 + 1;
                device
                    .write((round % 64) * EXTENT_SIZE, &vec![byte; BLOCK_SIZE as usize])
                    .unwrap();
            }
        })
    };
    for _ in 0..20 {
        device.snapshot().unwrap();
    }
    writer.join().unwrap();
    device.snapshot().unwrap();
    // the last of rounds 0..200 to write extent e is e + 192 (e < 8) or e + 128
    let expected: Vec<u8> = (0..64u64)
        .map(|e| {
            let last = if e < 8 { e + 192 } else { e + 128 };
            (last % 250) as u8 + 1
        })
        .collect();
    drop(device);
    let fresh = world.attach("base");
    for (extent, byte) in expected.iter().enumerate() {
        let block = fresh
            .read(extent as u64 * EXTENT_SIZE, BLOCK_SIZE as u32)
            .unwrap();
        assert!(block.iter().all(|b| b == byte), "extent {extent}");
    }
}

#[test]
fn prefetch_warms_every_stored_extent_without_clobbering_writes() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.write(0, &vec![0xCC; BLOCK_SIZE as usize]).unwrap(); // newer than the store
    let fetched = device.prefetch(4).unwrap();
    assert_eq!(fetched, 16, "the 16 stored extents of the 4 MiB base");
    let before = device.status().fetches;
    let bytes = device.read(0, (4 * MIB) as u32).unwrap();
    assert_eq!(
        device.status().fetches,
        before,
        "everything was already cached"
    );
    assert!(
        bytes[..BLOCK_SIZE as usize].iter().all(|&b| b == 0xCC),
        "the write survived"
    );
    assert!(
        bytes[BLOCK_SIZE as usize..2 * BLOCK_SIZE as usize]
            .iter()
            .all(|&b| b == pattern(1))
    );
}
