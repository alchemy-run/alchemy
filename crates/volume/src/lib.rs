//! Forkable block volumes kept in object storage.
//!
//! A volume is a sparse virtual disk divided into fixed-size **extents**.
//! Written extents are compressed and stored in immutable **packs**; a
//! **manifest** maps every extent to its place in a pack and names its parent
//! manifest, so a manifest is a snapshot and the chain of parents is the
//! volume's history. A **head** is a named pointer to a manifest: forking is
//! creating a head on an existing manifest, and nothing is copied.
//!
//! Everything addressed by hash is immutable, so a crash never corrupts a
//! volume: objects are written before a head moves, and a head moves with a
//! compare-and-set.

mod error;
mod extent;
mod gc;
mod id;
mod manifest;
mod pack;
pub mod store;
mod volume;

pub use error::{Error, Result};
pub use extent::{BLOCK_SIZE, EXTENT_SIZE, is_zero};
pub use gc::{GcOptions, GcReport};
pub use id::Hash;
pub use manifest::{Entry, Manifest, PAGE_ENTRIES, Page};
pub use pack::{Pack, PackBuilder};
pub use volume::{Change, Volume};
