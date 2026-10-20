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
#[cfg(target_os = "linux")]
pub mod copy;
mod device;
#[cfg(target_os = "linux")]
pub mod exec;
#[cfg(all(target_os = "linux", feature = "fuse"))]
pub mod fuse;
#[cfg(target_os = "linux")]
pub mod nbd;
pub mod store;
#[cfg(all(target_os = "linux", feature = "ublk"))]
pub mod ublk;

pub use device::{Device, Flusher, Status};

/// A helper program (`mount`, `fuse2fs`, `sync`, …) whose stdout goes to
/// blockd's stderr: `blockd exec`'s stdout is the command's alone.
pub(crate) fn helper(program: &str) -> std::process::Command {
    use std::os::fd::AsFd;
    let mut command = std::process::Command::new(program);
    if let Ok(stderr) = std::io::stderr().as_fd().try_clone_to_owned() {
        command.stdout(std::process::Stdio::from(stderr));
    }
    command
}
