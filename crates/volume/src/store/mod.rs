//! Where volumes live: a [`BlobStore`] for immutable objects (packs, pages,
//! manifests and journal entries) and a [`MetaStore`] for the only mutable
//! state, the heads.

#[cfg(feature = "http")]
mod http;
#[cfg(feature = "http")]
mod http_journal;
mod journal;
mod local;
mod memory;
#[cfg(feature = "object")]
mod object;

#[cfg(feature = "http")]
pub use http::HttpMetaStore;
#[cfg(feature = "http")]
pub use http_journal::HttpJournalStore;
pub use journal::{Appended, BlobJournalStore, JournalStore};
pub use local::{LocalBlobStore, LocalMetaStore};
pub use memory::{MemoryBlobStore, MemoryMetaStore};
#[cfg(feature = "object")]
pub use object::{ObjectBlobStore, ObjectMetaStore};

use crate::{Hash, Result};
use async_trait::async_trait;
use std::time::SystemTime;

/// An object found by [`BlobStore::list`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobMeta {
    pub key: String,
    pub size: u64,
    pub modified: SystemTime,
}

/// Immutable objects by key. Most keys are content-addressed, so writing the
/// same key twice writes the same bytes and is harmless.
#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()>;
    /// Writes `key` only if nothing is there yet; `false` if something was.
    /// Journal entries are named by position, and this is what makes two
    /// writers unable to both claim one.
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool>;
    async fn get(&self, key: &str) -> Result<Vec<u8>>;
    /// Bytes `start..end` of an object.
    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>>;
    async fn exists(&self, key: &str) -> Result<bool>;
    /// Every object whose key starts with `prefix` (for garbage collection).
    async fn list(&self, prefix: &str) -> Result<Vec<BlobMeta>>;
    /// Deletes an object; deleting a missing object is not an error.
    async fn delete(&self, key: &str) -> Result<()>;
}

/// A position in a head's journal: entry `seq` of lease `epoch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct JournalPos {
    pub epoch: u64,
    pub seq: u64,
}

/// A head: the snapshot it points at, and who may write it.
///
/// Every lease and every reset bumps `epoch`, which fences the writer before
/// it. A writer journals under its own epoch; entries of `epoch` before `seq`
/// are already in `snapshot`. `pending` is an earlier writer's journal that
/// hasn't been folded into `snapshot` yet: the next lease folds it first.
///
/// A deleted head stays as a tombstone with its last epoch, so a head
/// created again under the same name never reuses an epoch: an old writer
/// or a leftover journal entry can never pass for the new head's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Head {
    pub snapshot: Hash,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub pending: Option<JournalPos>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

impl Head {
    /// A head on `snapshot` that nobody has written.
    pub fn new(snapshot: Hash) -> Self {
        Self {
            snapshot,
            epoch: 0,
            seq: 0,
            pending: None,
            deleted: false,
        }
    }

    /// JSON. A bare snapshot id, the format before leases, also decodes.
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a head serializes")
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?.trim();
        if let Some(id) = Hash::from_hex(text) {
            return Some(Self::new(id));
        }
        serde_json::from_str(text).ok()
    }
}

/// Named heads. The only writes are compare-and-set on the whole record, so
/// concurrent writers can never both move a head, and a lease that was
/// superseded can't move it at all.
#[async_trait]
pub trait MetaStore: Send + Sync {
    async fn get(&self, head: &str) -> Result<Option<Head>>;
    /// Replaces `head` if it's exactly `expected` (`None` creates or deletes
    /// it). Fails with [`crate::Error::Conflict`] otherwise.
    async fn cas(&self, head: &str, expected: Option<&Head>, new: Option<&Head>) -> Result<()>;
    async fn list(&self) -> Result<Vec<(String, Head)>>;
}

pub(crate) fn conflict(head: &str, expected: Option<&Head>, found: Option<&Head>) -> crate::Error {
    crate::Error::Conflict {
        head: head.into(),
        expected: expected.map(|h| h.snapshot),
        found: found.map(|h| h.snapshot),
    }
}

pub(crate) fn check_head_name(head: &str) -> Result<()> {
    let ok = !head.is_empty()
        && head.len() <= 200
        && head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(crate::Error::Invalid(format!("head name {head:?}")))
    }
}
