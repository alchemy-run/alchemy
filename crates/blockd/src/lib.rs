//! blockd serves a [`volume`] as a block device.
//!
//! The block layer ([`Device`]) is shared by every attach mode: reads fetch
//! missing extents from the store into a local cache file, writes land in the
//! cache and are marked dirty, and a flush commits the dirty extents as a new
//! snapshot and moves the volume's head. Attach modes are front ends that
//! translate a kernel (or userspace) protocol into those calls; NBD is the
//! first.

mod bitmap;
pub mod control;
mod device;
#[cfg(target_os = "linux")]
pub mod nbd;
pub mod store;

pub use device::{Device, Status};
