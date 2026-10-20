//! Where journal entries live. The default keeps them in the blob store
//! and checks the lease against the head store after each append; a
//! coordinator that holds the head (a Durable Object) can do both in one
//! request ([`super::HttpJournalStore`]).

use super::{BlobStore, MetaStore};
use crate::{Result, journal};
use async_trait::async_trait;
use std::ops::Range;
use std::sync::Arc;

/// What an append found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Appended {
    /// The entry is durable, and the lease still held the head after it was.
    Written,
    /// The position already holds these bytes: an earlier attempt landed.
    Already,
    /// Another lease holds the head, or the position holds someone else's entry.
    Fenced,
}

#[async_trait]
pub trait JournalStore: Send + Sync {
    /// Writes entry `seq` of lease `epoch` if the position is free, and
    /// reports [`Appended::Fenced`] unless `epoch` still holds `head` once it
    /// is durable.
    async fn append(&self, head: &str, epoch: u64, seq: u64, bytes: Vec<u8>) -> Result<Appended>;
    /// The entry at a position, if there is one.
    async fn get(&self, head: &str, epoch: u64, seq: u64) -> Result<Option<Vec<u8>>>;
    /// Deletes the entries at `seqs` of lease `epoch` (folded); missing ones are fine.
    async fn delete(&self, head: &str, epoch: u64, seqs: Range<u64>) -> Result<()>;
    /// The most blocks one entry may hold.
    fn max_entry_blocks(&self) -> usize {
        4096
    }
}

/// Entries as blobs at `journal/{head}/{epoch}/{seq}`.
pub struct BlobJournalStore {
    blobs: Arc<dyn BlobStore>,
    meta: Arc<dyn MetaStore>,
}

impl BlobJournalStore {
    pub fn new(blobs: Arc<dyn BlobStore>, meta: Arc<dyn MetaStore>) -> Self {
        Self { blobs, meta }
    }
}

#[async_trait]
impl JournalStore for BlobJournalStore {
    async fn append(&self, head: &str, epoch: u64, seq: u64, bytes: Vec<u8>) -> Result<Appended> {
        let key = journal::key(head, epoch, seq);
        let outcome = if self.blobs.put_new(&key, bytes.clone()).await? {
            Appended::Written
        } else if self.blobs.get(&key).await? == bytes {
            Appended::Already
        } else {
            return Ok(Appended::Fenced);
        };
        // The check after the write is the fence (see `lease.rs`).
        let current = self.meta.get(head).await?;
        if current.map(|record| (record.epoch, record.deleted)) != Some((epoch, false)) {
            return Ok(Appended::Fenced);
        }
        Ok(outcome)
    }

    async fn get(&self, head: &str, epoch: u64, seq: u64) -> Result<Option<Vec<u8>>> {
        match self.blobs.get(&journal::key(head, epoch, seq)).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(crate::Error::Missing(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn delete(&self, head: &str, epoch: u64, seqs: Range<u64>) -> Result<()> {
        for seq in seqs {
            self.blobs.delete(&journal::key(head, epoch, seq)).await?;
        }
        Ok(())
    }
}
