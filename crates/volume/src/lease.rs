//! Leases: one writer per head at a time, journaling without snapshotting.
//!
//! [`Volume::acquire`] bumps the head's epoch, which supersedes whoever held
//! it, then folds the previous writer's journal into a snapshot. From then
//! on [`Volume::append`] makes blocks durable with one journal entry, and
//! [`Volume::commit_leased`] makes a snapshot and marks the journal folded.
//!
//! A superseded writer finds out on its next write: every append checks,
//! after its entry lands, that the head's epoch is still its own, and a
//! snapshot moves the head only from the record the lease last wrote. It
//! gets [`Error::Fenced`] and must stop; nothing it writes becomes visible.
//!
//! The check after the write is what makes an acknowledgement safe. A new
//! lease bumps the epoch before it reads the old journal, so an entry that
//! landed before the bump is read and folded, and an entry that landed after
//! it fails its check. A fence object in the journal wouldn't be enough:
//! deleting folded entries frees their names again (SlateDB's RFC 0026
//! describes the same hazard for its manifests).

use crate::journal;
use crate::store::{Head, JournalPos};
use crate::{BLOCK_SIZE, Change, EXTENT_SIZE, Error, Hash, Result, Volume};
use std::collections::BTreeMap;

const BLOCKS_PER_EXTENT: u64 = EXTENT_SIZE / BLOCK_SIZE;

/// The right to write one head, until another lease supersedes it.
#[derive(Clone, Debug)]
pub struct Lease {
    head: String,
    /// The head's record as this lease last wrote it.
    record: Head,
    /// The next journal position to write.
    next: u64,
}

impl Lease {
    pub fn head(&self) -> &str {
        &self.head
    }

    pub fn epoch(&self) -> u64 {
        self.record.epoch
    }

    /// The snapshot this lease's journal applies to.
    pub fn snapshot(&self) -> Hash {
        self.record.snapshot
    }

    /// Journal entries written since the last snapshot.
    pub fn journaled(&self) -> u64 {
        self.next - self.record.seq
    }
}

impl Volume {
    /// Takes the lease on `head`, superseding its current writer, and folds
    /// whatever journal that writer left into a snapshot.
    pub async fn acquire(&self, head: &str) -> Result<Lease> {
        let mut attempts = 0;
        let record = loop {
            let current = self.record(head).await?;
            let next = Head {
                snapshot: current.snapshot,
                epoch: current.epoch + 1,
                seq: 0,
                // A writer journals only once nothing is pending, so at most
                // one earlier journal is ever unfolded.
                pending: current.pending.or(Some(JournalPos {
                    epoch: current.epoch,
                    seq: current.seq,
                })),
                deleted: false,
            };
            match self.meta().cas(head, Some(&current), Some(&next)).await {
                Ok(()) => break next,
                // The write may have landed with its response lost.
                Err(Error::Conflict { .. }) if self.record(head).await? == next => break next,
                Err(Error::Conflict { .. }) if attempts < 8 => attempts += 1,
                Err(e) => return Err(e),
            }
        };
        let mut lease = Lease {
            head: head.to_string(),
            record,
            next: 0,
        };
        self.recover(&mut lease).await?;
        Ok(lease)
    }

    /// Makes `blocks` durable as the lease's next journal entry. Fails with
    /// [`Error::Fenced`] if another lease took over.
    pub async fn append(&self, lease: &mut Lease, blocks: Vec<(u64, Vec<u8>)>) -> Result<()> {
        if lease.record.pending.is_some() {
            return Err(Error::Invalid("the lease hasn't recovered its head".into()));
        }
        if blocks.is_empty() {
            return Ok(());
        }
        let (epoch, seq) = (lease.record.epoch, lease.next);
        let key = journal::key(&lease.head, epoch, seq);
        let bytes = journal::encode(&blocks, epoch, seq)?;
        if !self.blobs().put_new(&key, bytes.clone()).await? {
            // Ours from an attempt whose response was lost, or not ours at all.
            if self.blobs().get(&key).await? != bytes {
                return Err(Error::Fenced(lease.head.clone()));
            }
        }
        let current = self.meta().get(&lease.head).await?;
        if current.map(|record| (record.epoch, record.deleted)) != Some((epoch, false)) {
            return Err(Error::Fenced(lease.head.clone()));
        }
        lease.next += 1;
        Ok(())
    }

    /// Commits `changes` on the lease's snapshot as a new snapshot, moves the
    /// head to it, and marks every entry journaled so far as folded (the
    /// changes must include them). Returns the head's snapshot.
    pub async fn commit_leased(
        &self,
        lease: &mut Lease,
        changes: Vec<(u64, Change)>,
    ) -> Result<Hash> {
        if lease.record.pending.is_some() {
            return Err(Error::Invalid("the lease hasn't recovered its head".into()));
        }
        let snapshot = if changes.is_empty() {
            lease.record.snapshot
        } else {
            self.snapshot(&lease.record.snapshot, changes).await?
        };
        let folded = lease.record.seq..lease.next;
        let next = Head {
            snapshot,
            seq: lease.next,
            ..lease.record
        };
        if next != lease.record {
            self.move_leased(lease, next).await?;
        }
        let epoch = lease.record.epoch;
        self.delete_journal(&lease.head, epoch, folded).await;
        Ok(snapshot)
    }

    /// Folds the previous writer's journal into a snapshot.
    async fn recover(&self, lease: &mut Lease) -> Result<()> {
        let Some(pending) = lease.record.pending else {
            return Ok(());
        };
        let (blocks, end) = self.read_journal(&lease.head, pending).await?;
        let snapshot = if blocks.is_empty() {
            lease.record.snapshot
        } else {
            self.apply_blocks(&lease.record.snapshot, blocks).await?
        };
        let next = Head {
            snapshot,
            pending: None,
            ..lease.record
        };
        self.move_leased(lease, next).await?;
        self.delete_journal(&lease.head, pending.epoch, pending.seq..end)
            .await;
        Ok(())
    }

    /// Reads `from`'s journal up to its first missing entry. Returns the
    /// blocks, latest write of each, and where the journal ends.
    async fn read_journal(
        &self,
        head: &str,
        from: JournalPos,
    ) -> Result<(BTreeMap<u64, Vec<u8>>, u64)> {
        let mut blocks = BTreeMap::new();
        let mut seq = from.seq;
        loop {
            let key = journal::key(head, from.epoch, seq);
            let bytes = match self.blobs().get(&key).await {
                Ok(bytes) => bytes,
                Err(Error::Missing(_)) => return Ok((blocks, seq)),
                Err(e) => return Err(e),
            };
            blocks.extend(journal::decode(&key, &bytes, from.epoch, seq)?);
            seq += 1;
        }
    }

    /// `base` with whole blocks replaced, as a new snapshot.
    async fn apply_blocks(&self, base: &Hash, blocks: BTreeMap<u64, Vec<u8>>) -> Result<Hash> {
        let size = self.manifest(base).await?.size;
        let mut by_extent: BTreeMap<u64, Vec<(u64, Vec<u8>)>> = BTreeMap::new();
        for (block, bytes) in blocks {
            if (block + 1) * BLOCK_SIZE > size {
                return Err(Error::Invalid(format!(
                    "journal block {block} is past the end"
                )));
            }
            by_extent
                .entry(block / BLOCKS_PER_EXTENT)
                .or_default()
                .push((block, bytes));
        }
        let mut changes = Vec::with_capacity(by_extent.len());
        for (extent, blocks) in by_extent {
            let mut bytes = self
                .read_extent(base, extent)
                .await?
                .unwrap_or_else(|| vec![0; EXTENT_SIZE as usize]);
            for (block, data) in blocks {
                let at = ((block % BLOCKS_PER_EXTENT) * BLOCK_SIZE) as usize;
                bytes[at..at + BLOCK_SIZE as usize].copy_from_slice(&data);
            }
            changes.push((extent, Change::Write(bytes)));
        }
        self.snapshot(base, changes).await
    }

    /// Replaces the head's record, as long as the lease still holds it.
    async fn move_leased(&self, lease: &mut Lease, next: Head) -> Result<()> {
        match self
            .meta()
            .cas(&lease.head, Some(&lease.record), Some(&next))
            .await
        {
            Ok(()) => {}
            Err(Error::Conflict { .. }) if self.meta().get(&lease.head).await? == Some(next) => {}
            Err(Error::Conflict { .. }) => return Err(Error::Fenced(lease.head.clone())),
            Err(e) => return Err(e),
        }
        lease.record = next;
        Ok(())
    }

    /// Best effort: garbage collection deletes whatever this misses.
    async fn delete_journal(&self, head: &str, epoch: u64, seqs: std::ops::Range<u64>) {
        for seq in seqs {
            if self
                .blobs()
                .delete(&journal::key(head, epoch, seq))
                .await
                .is_err()
            {
                return;
            }
        }
    }
}
