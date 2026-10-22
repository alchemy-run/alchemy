//! blockd serves a [`volume`] as a block device.
//!
//! The block layer ([`Device`]) is shared by every attach mode: reads fetch
//! missing extents from the store into a local cache file, writes land in the
//! cache, a sync makes them durable in the head's journal, and a snapshot
//! commits them as a new snapshot of the head. Attach modes ([`mount`]) are
//! front ends that translate a kernel (or userspace) protocol into those
//! calls.

mod bitmap;
#[cfg(target_os = "linux")]
pub mod call;
#[cfg(target_os = "linux")]
pub mod container;
pub mod control;
#[cfg(target_os = "linux")]
pub mod daemon;
mod device;
#[cfg(target_os = "linux")]
pub mod exec;
#[cfg(target_os = "linux")]
pub mod fs;
#[cfg(all(target_os = "linux", feature = "fuse"))]
pub mod fuse;
#[cfg(target_os = "linux")]
pub mod head;
pub mod http;
#[cfg(target_os = "linux")]
pub mod mount;
#[cfg(target_os = "linux")]
pub mod nbd;
#[cfg(target_os = "linux")]
pub mod patch;
#[cfg(target_os = "linux")]
pub mod sendstream;
pub mod store;
pub mod timings;
#[cfg(target_os = "linux")]
pub mod track;
#[cfg(all(target_os = "linux", feature = "ublk"))]
pub mod ublk;

pub use device::{Device, Flusher, Status};

/// A helper program (`mount`, `losetup`, `sync`, …) whose stdout goes to
/// blockd's stderr: `blockd exec`'s stdout is the command's alone.
pub(crate) fn helper(program: &str) -> std::process::Command {
    use std::os::fd::AsFd;
    let mut command = std::process::Command::new(program);
    if let Ok(stderr) = std::io::stderr().as_fd().try_clone_to_owned() {
        command.stdout(std::process::Stdio::from(stderr));
    }
    command
}
