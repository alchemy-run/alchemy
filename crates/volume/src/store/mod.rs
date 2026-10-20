//! Where volumes live: a [`BlobStore`] for immutable, content-addressed
//! objects (packs, pages, manifests) and a [`MetaStore`] for the only mutable
//! state, the heads.

mod local;
mod memory;
#[cfg(feature = "object")]
mod object;

pub use local::{LocalBlobStore, LocalMetaStore};
pub use memory::{MemoryBlobStore, MemoryMetaStore};
#[cfg(feature = "object")]
pub use object::{ObjectBlobStore, ObjectMetaStore};

use crate::{Hash, Result};
use async_trait::async_trait;

/// Immutable objects by key. Keys are content-addressed, so writing the same
/// key twice writes the same bytes and is harmless.
#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()>;
    async fn get(&self, key: &str) -> Result<Vec<u8>>;
    /// Bytes `start..end` of an object.
    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>>;
    async fn exists(&self, key: &str) -> Result<bool>;
}

/// Named heads, each pointing at a manifest. The only writes are
/// compare-and-set, so concurrent writers can never both move a head.
#[async_trait]
pub trait MetaStore: Send + Sync {
    async fn get(&self, head: &str) -> Result<Option<Hash>>;
    /// Moves `head` from `expected` to `new` (`None` creates or deletes it).
    /// Fails with [`crate::Error::Conflict`] if the head isn't at `expected`.
    async fn cas(&self, head: &str, expected: Option<Hash>, new: Option<Hash>) -> Result<()>;
    async fn list(&self) -> Result<Vec<(String, Hash)>>;
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
