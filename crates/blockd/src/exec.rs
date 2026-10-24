//! One command against a volume: mount it at a directory in the best mode
//! the host allows, run the command there, unmount, and snapshot. A sandbox
//! can run `blockd exec` the same way on every host.

use crate::Device;
use crate::mount::{Mode, mount};
use anyhow::Result;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

/// Runs `command` (with `sh -c`) in `dir` with the volume mounted there, and
/// returns its exit code. The command's writes are snapshotted whatever its
/// exit code; close the device after.
pub fn exec(
    device: &Arc<Device>,
    mode: Mode,
    cache: &Path,
    dir: &Path,
    command: &str,
) -> Result<i32> {
    let mounted = mount(device, mode, cache, dir)?;
    let code = run(command, dir);
    let unmounted = mounted.unmount();
    let code = code?;
    unmounted?;
    device.snapshot()?;
    Ok(code)
}

fn run(command: &str, dir: &Path) -> Result<i32> {
    let status = Command::new("sh")
        .args(["-c", command])
        .current_dir(dir)
        .status()?;
    Ok(status.code().unwrap_or(128))
}
