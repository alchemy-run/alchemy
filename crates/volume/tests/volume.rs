use std::sync::Arc;
use std::sync::atomic::Ordering;
use volume::store::{LocalBlobStore, LocalMetaStore, MemoryBlobStore, MemoryMetaStore};
use volume::{Change, EXTENT_SIZE, Error, Volume};

const MIB: u64 = 1024 * 1024;

fn extent(byte: u8) -> Vec<u8> {
    vec![byte; EXTENT_SIZE as usize]
}

fn memory() -> (Volume, Arc<MemoryBlobStore>) {
    let blobs = Arc::new(MemoryBlobStore::new());
    (
        Volume::new(blobs.clone(), Arc::new(MemoryMetaStore::new())),
        blobs,
    )
}

#[tokio::test]
async fn a_new_volume_reads_as_zeros_and_stores_nothing_per_extent() {
    let (volume, blobs) = memory();
    let id = volume.create("main", 64 * MIB).await.unwrap();
    assert_eq!(volume.head("main").await.unwrap(), id);
    assert_eq!(volume.read_extent(&id, 0).await.unwrap(), None);
    assert_eq!(volume.read_extent(&id, 255).await.unwrap(), None);
    assert!(matches!(
        volume.read_extent(&id, 256).await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(blobs.len(), 1, "only the manifest");
}

#[tokio::test]
async fn a_commit_moves_the_head_and_its_extents_read_back() {
    let (volume, _) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let next = volume
        .commit(
            "main",
            &base,
            vec![
                (3, Change::Write(extent(3))),
                (200, Change::Write(extent(9))),
            ],
        )
        .await
        .unwrap();
    assert_ne!(next, base);
    assert_eq!(volume.head("main").await.unwrap(), next);
    assert_eq!(volume.read_extent(&next, 3).await.unwrap(), Some(extent(3)));
    assert_eq!(
        volume.read_extent(&next, 200).await.unwrap(),
        Some(extent(9))
    );
    assert_eq!(volume.read_extent(&next, 4).await.unwrap(), None);
    // the old snapshot is untouched
    assert_eq!(volume.read_extent(&base, 3).await.unwrap(), None);
}

#[tokio::test]
async fn an_empty_commit_writes_nothing() {
    let (volume, blobs) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let before = blobs.len();
    assert_eq!(volume.commit("main", &base, vec![]).await.unwrap(), base);
    assert_eq!(blobs.len(), before);
}

#[tokio::test]
async fn forks_share_their_base_and_are_isolated() {
    let (volume, _) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let base = volume
        .commit("main", &base, vec![(0, Change::Write(extent(1)))])
        .await
        .unwrap();

    assert_eq!(volume.fork("main", "try-a").await.unwrap(), base);
    volume.fork("main", "try-b").await.unwrap();
    let a = volume
        .commit("try-a", &base, vec![(0, Change::Write(extent(0xA)))])
        .await
        .unwrap();
    let b = volume
        .commit("try-b", &base, vec![(1, Change::Write(extent(0xB)))])
        .await
        .unwrap();

    assert_eq!(volume.read_extent(&a, 0).await.unwrap(), Some(extent(0xA)));
    assert_eq!(volume.read_extent(&a, 1).await.unwrap(), None);
    assert_eq!(volume.read_extent(&b, 0).await.unwrap(), Some(extent(1)));
    assert_eq!(volume.read_extent(&b, 1).await.unwrap(), Some(extent(0xB)));
    assert_eq!(volume.head("main").await.unwrap(), base, "main never moved");

    // keep b: main adopts it, and the losing fork is dropped
    volume.reset("main", b).await.unwrap();
    volume.drop_head("try-a").await.unwrap();
    assert_eq!(volume.head("main").await.unwrap(), b);
    assert!(matches!(volume.head("try-a").await, Err(Error::NoHead(_))));
    assert!(matches!(
        volume.fork("main", "try-b").await,
        Err(Error::HeadExists(_))
    ));
}

#[tokio::test]
async fn history_walks_snapshots_and_reset_rewinds() {
    let (volume, _) = memory();
    let mut id = volume.create("main", 64 * MIB).await.unwrap();
    let mut ids = vec![id];
    for step in 1..=5u8 {
        id = volume
            .commit("main", &id, vec![(0, Change::Write(extent(step)))])
            .await
            .unwrap();
        ids.push(id);
    }
    let history = volume.history(&id, 10).await.unwrap();
    assert_eq!(history, ids.iter().rev().copied().collect::<Vec<_>>());
    assert_eq!(volume.history(&id, 2).await.unwrap().len(), 2);

    volume.reset("main", ids[2]).await.unwrap();
    let head = volume.head("main").await.unwrap();
    assert_eq!(volume.read_extent(&head, 0).await.unwrap(), Some(extent(2)));
}

#[tokio::test]
async fn a_stale_base_is_a_conflict() {
    let (volume, _) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    volume
        .commit("main", &base, vec![(0, Change::Write(extent(1)))])
        .await
        .unwrap();
    let stale = volume
        .commit("main", &base, vec![(1, Change::Write(extent(2)))])
        .await;
    assert!(matches!(stale, Err(Error::Conflict { .. })));
}

#[tokio::test]
async fn zero_writes_and_trims_store_nothing() {
    let (volume, _) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let written = volume
        .commit("main", &base, vec![(5, Change::Write(extent(5)))])
        .await
        .unwrap();
    let trimmed = volume
        .commit(
            "main",
            &written,
            vec![(5, Change::Zero), (6, Change::Write(extent(0)))],
        )
        .await
        .unwrap();
    assert_eq!(volume.read_extent(&trimmed, 5).await.unwrap(), None);
    assert_eq!(volume.read_extent(&trimmed, 6).await.unwrap(), None);
    let manifest = volume.manifest(&trimmed).await.unwrap();
    assert!(
        manifest.pages.iter().all(Option::is_none),
        "an all-zero page is omitted"
    );
}

#[tokio::test]
async fn rewriting_an_unchanged_extent_uploads_no_pack() {
    let (volume, blobs) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let one = volume
        .commit("main", &base, vec![(0, Change::Write(extent(1)))])
        .await
        .unwrap();
    let packs = |blobs: &MemoryBlobStore| {
        blobs
            .keys()
            .iter()
            .filter(|k| k.starts_with("packs/"))
            .count()
    };
    let before = packs(&blobs);
    volume
        .commit("main", &one, vec![(0, Change::Write(extent(1)))])
        .await
        .unwrap();
    assert_eq!(packs(&blobs), before);
}

#[tokio::test]
async fn diff_lists_changed_extents_only() {
    let (volume, _) = memory();
    let base = volume.create("main", 512 * MIB).await.unwrap(); // 2 pages
    let a = volume
        .commit(
            "main",
            &base,
            vec![
                (1, Change::Write(extent(1))),
                (1500, Change::Write(extent(2))),
            ],
        )
        .await
        .unwrap();
    let b = volume
        .commit("main", &a, vec![(1500, Change::Write(extent(3)))])
        .await
        .unwrap();
    assert_eq!(volume.diff(&base, &a).await.unwrap(), vec![1, 1500]);
    assert_eq!(volume.diff(&a, &b).await.unwrap(), vec![1500]);
    assert!(volume.diff(&b, &b).await.unwrap().is_empty());
}

#[tokio::test]
async fn import_stores_only_non_zero_extents() {
    let (volume, blobs) = memory();
    let mut image = vec![0u8; (10 * EXTENT_SIZE + 100) as usize];
    image[0] = 1; // extent 0
    image[(7 * EXTENT_SIZE + 9) as usize] = 7; // extent 7
    image[(10 * EXTENT_SIZE + 99) as usize] = 10; // the short last extent
    let id = volume
        .import("base", image.len() as u64, image.as_slice())
        .await
        .unwrap();
    let manifest = volume.manifest(&id).await.unwrap();
    assert_eq!(manifest.size, 11 * EXTENT_SIZE);
    for extent_index in 0..11u64 {
        let read = volume.read_extent(&id, extent_index).await.unwrap();
        let start = (extent_index * EXTENT_SIZE) as usize;
        let mut expected = vec![0u8; EXTENT_SIZE as usize];
        let end = (start + EXTENT_SIZE as usize).min(image.len());
        expected[..end - start].copy_from_slice(&image[start..end]);
        if expected.iter().all(|&b| b == 0) {
            assert_eq!(read, None, "extent {extent_index}");
        } else {
            assert_eq!(read, Some(expected), "extent {extent_index}");
        }
    }
    assert_eq!(
        blobs
            .keys()
            .iter()
            .filter(|k| k.starts_with("packs/"))
            .count(),
        1
    );
}

#[tokio::test]
async fn reads_fetch_one_range_per_extent_and_cache_metadata() {
    let (volume, blobs) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let id = volume
        .commit(
            "main",
            &base,
            (0..8)
                .map(|i| (i, Change::Write(extent(i as u8 + 1))))
                .collect(),
        )
        .await
        .unwrap();
    blobs.gets.store(0, Ordering::Relaxed);
    for i in 0..8 {
        volume.read_extent(&id, i).await.unwrap();
    }
    // manifest and page are cached from the commit; one ranged GET per extent
    assert_eq!(blobs.gets.load(Ordering::Relaxed), 8);
}

#[tokio::test]
async fn a_local_store_persists_across_processes() {
    let dir = tempfile::tempdir().unwrap();
    let open = || {
        Volume::new(
            Arc::new(LocalBlobStore::new(dir.path().join("blobs")).unwrap()),
            Arc::new(LocalMetaStore::new(dir.path().join("heads")).unwrap()),
        )
    };
    let id = {
        let volume = open();
        let base = volume.create("main", 64 * MIB).await.unwrap();
        volume
            .commit("main", &base, vec![(2, Change::Write(extent(2)))])
            .await
            .unwrap()
    };
    let volume = open(); // nothing cached
    assert_eq!(volume.head("main").await.unwrap(), id);
    assert_eq!(volume.read_extent(&id, 2).await.unwrap(), Some(extent(2)));
    assert_eq!(
        volume.heads().await.unwrap(),
        vec![("main".to_string(), id)]
    );
}

#[tokio::test]
async fn corrupted_objects_are_detected() {
    let dir = tempfile::tempdir().unwrap();
    let blobs = Arc::new(LocalBlobStore::new(dir.path().join("blobs")).unwrap());
    let volume = Volume::new(
        blobs.clone(),
        Arc::new(LocalMetaStore::new(dir.path().join("heads")).unwrap()),
    );
    let base = volume.create("main", 64 * MIB).await.unwrap();
    let id = volume
        .commit("main", &base, vec![(0, Change::Write(extent(1)))])
        .await
        .unwrap();
    let entry = volume.entry(&id, 0).await.unwrap().unwrap();

    // flip a byte inside the stored extent
    let path = dir
        .path()
        .join("blobs")
        .join(format!("packs/{}", entry.pack.to_hex()));
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[entry.offset as usize + 5] ^= 0xff;
    std::fs::write(&path, bytes).unwrap();

    let fresh = Volume::new(
        blobs,
        Arc::new(LocalMetaStore::new(dir.path().join("heads")).unwrap()),
    );
    assert!(matches!(
        fresh.read_extent(&id, 0).await,
        Err(Error::Corrupt { .. })
    ));
}

#[tokio::test]
async fn writes_must_be_whole_extents_inside_the_volume() {
    let (volume, _) = memory();
    let base = volume.create("main", 64 * MIB).await.unwrap();
    assert!(matches!(
        volume
            .snapshot(&base, vec![(0, Change::Write(vec![1; 10]))])
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        volume.snapshot(&base, vec![(256, Change::Zero)]).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        volume.create("bad", 1000).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        volume.create("bad/name", 64 * MIB).await,
        Err(Error::Invalid(_))
    ));
}

mod gc {
    use super::*;
    use std::time::Duration;
    use volume::GcOptions;

    const OLD: Duration = Duration::from_secs(7200);

    fn now() -> GcOptions {
        GcOptions {
            grace: Duration::from_secs(3600),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn nothing_reachable_is_deleted() {
        let (volume, blobs) = memory();
        let base = volume.create("main", 64 * MIB).await.unwrap();
        let one = volume
            .commit("main", &base, vec![(0, Change::Write(extent(1)))])
            .await
            .unwrap();
        volume.fork("main", "fork").await.unwrap();
        volume
            .commit("fork", &one, vec![(1, Change::Write(extent(2)))])
            .await
            .unwrap();
        blobs.age_all(OLD);
        let before = blobs.len();
        let report = volume.gc(&now()).await.unwrap();
        assert_eq!(report.deleted, 0);
        assert_eq!(blobs.len(), before);
        assert_eq!(report.heads, 2);
        assert_eq!(report.snapshots, 3);
    }

    #[tokio::test]
    async fn a_dropped_fork_is_collected_and_the_rest_still_reads() {
        let (volume, blobs) = memory();
        let base = volume.create("main", 64 * MIB).await.unwrap();
        let one = volume
            .commit("main", &base, vec![(0, Change::Write(extent(1)))])
            .await
            .unwrap();
        volume.fork("main", "loser").await.unwrap();
        volume
            .commit("loser", &one, vec![(5, Change::Write(extent(5)))])
            .await
            .unwrap();
        volume.drop_head("loser").await.unwrap();
        blobs.age_all(OLD);

        let report = volume.gc(&now()).await.unwrap();
        // the loser's pack, page and manifest
        assert_eq!(report.deleted, 3, "{report:?}");
        assert_eq!(volume.read_extent(&one, 0).await.unwrap(), Some(extent(1)));
    }

    #[tokio::test]
    async fn history_can_be_pruned() {
        let (volume, blobs) = memory();
        let mut id = volume.create("main", 64 * MIB).await.unwrap();
        for step in 1..=5u8 {
            id = volume
                .commit("main", &id, vec![(0, Change::Write(extent(step)))])
                .await
                .unwrap();
        }
        blobs.age_all(OLD);
        let report = volume
            .gc(&GcOptions {
                history: Some(2),
                ..now()
            })
            .await
            .unwrap();
        assert_eq!(report.snapshots, 2);
        assert!(report.deleted >= 4, "{report:?}");
        assert_eq!(volume.read_extent(&id, 0).await.unwrap(), Some(extent(5)));
        assert_eq!(
            volume.history(&id, 10).await.unwrap().len(),
            2,
            "history ends where it was pruned"
        );
    }

    #[tokio::test]
    async fn young_unreachable_objects_are_spared() {
        let (volume, _) = memory();
        let base = volume.create("main", 64 * MIB).await.unwrap();
        // an in-flight commit: uploaded, head not moved yet
        let pending = volume
            .snapshot(&base, vec![(0, Change::Write(extent(9)))])
            .await
            .unwrap();
        let report = volume.gc(&now()).await.unwrap();
        assert_eq!(report.deleted, 0);
        assert!(report.spared >= 3);
        volume
            .commit("main", &base, vec![(0, Change::Write(extent(9)))])
            .await
            .unwrap();
        assert_eq!(
            volume.read_extent(&pending, 0).await.unwrap(),
            Some(extent(9))
        );
    }

    #[tokio::test]
    async fn a_dry_run_deletes_nothing() {
        let (volume, blobs) = memory();
        let base = volume.create("main", 64 * MIB).await.unwrap();
        volume.fork("main", "loser").await.unwrap();
        volume
            .commit("loser", &base, vec![(5, Change::Write(extent(5)))])
            .await
            .unwrap();
        volume.drop_head("loser").await.unwrap();
        blobs.age_all(OLD);
        let before = blobs.len();
        let report = volume
            .gc(&GcOptions {
                dry_run: true,
                ..now()
            })
            .await
            .unwrap();
        assert_eq!(report.deleted, 3);
        assert_eq!(blobs.len(), before);
    }

    #[tokio::test]
    async fn the_local_store_lists_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = Arc::new(LocalBlobStore::new(dir.path().join("blobs")).unwrap());
        let volume = Volume::new(
            blobs.clone(),
            Arc::new(LocalMetaStore::new(dir.path().join("heads")).unwrap()),
        );
        let base = volume.create("main", 64 * MIB).await.unwrap();
        volume.fork("main", "loser").await.unwrap();
        volume
            .commit("loser", &base, vec![(5, Change::Write(extent(5)))])
            .await
            .unwrap();
        volume.drop_head("loser").await.unwrap();
        use volume::store::BlobStore;
        assert_eq!(blobs.list("packs/").await.unwrap().len(), 1);
        let report = volume
            .gc(&GcOptions {
                grace: Duration::ZERO,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(report.deleted, 3);
        assert!(blobs.list("packs/").await.unwrap().is_empty());
        assert_eq!(volume.read_extent(&base, 0).await.unwrap(), None);
    }
}
