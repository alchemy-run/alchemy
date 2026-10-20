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
        let cache = self.dir.path().join(format!("cache-{n}"));
        Device::open(
            self.volume.clone(),
            head,
            &cache,
            self.runtime.handle().clone(),
        )
        .unwrap()
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
fn a_flush_is_seen_by_the_next_machine() {
    let world = World::new();
    world.base("base");
    let first = world.attach("base");
    first
        .write(10 * MIB, &vec![0xAB; (3 * BLOCK_SIZE) as usize])
        .unwrap();
    let snapshot = first.flush().unwrap();
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
    device.flush().unwrap();

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
    device.flush().unwrap();

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
fn a_flush_with_nothing_dirty_writes_nothing() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.read(0, BLOCK_SIZE as u32).unwrap();
    let before = device.status().base;
    assert_eq!(device.flush().unwrap(), before);
    assert_eq!(device.status().flushes, 0);
}

#[test]
fn zeroing_a_range_reads_as_zeros_everywhere() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    device.zero(0, EXTENT_SIZE).unwrap();
    device.flush().unwrap();
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
fn every_flush_is_a_snapshot_to_rewind_to() {
    let world = World::new();
    world.base("base");
    let device = world.attach("base");
    let mut snapshots = Vec::new();
    for step in 1..=3u8 {
        device.write(0, &vec![step; BLOCK_SIZE as usize]).unwrap();
        snapshots.push(device.flush().unwrap());
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
