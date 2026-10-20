//! The control socket: one JSON request per line, one JSON reply per line.
//!
//! ```text
//! {"op":"status"}
//! {"op":"sync"}                                   → {"ok":true}
//! {"op":"snapshot"}                               → {"ok":true,"snapshot":"…"}
//! {"op":"fork","to":"try-1","freeze":"/workspace"} → {"ok":true,"snapshot":"…"}
//! {"op":"detach"}                                → {"ok":true,"snapshot":"…"}
//! ```
//!
//! `sync` makes every write so far durable in the journal; `snapshot` (`flush`
//! is the old name) commits them as a snapshot. `freeze` names the mounted
//! filesystem: it's frozen (`fsfreeze`) around the snapshot, so the fork is a
//! clean point even while programs are writing.

use crate::Device;
use anyhow::{Result, bail};
use serde::Deserialize;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Status,
    Sync,
    #[serde(alias = "flush")]
    Snapshot,
    Fork {
        to: String,
        freeze: Option<String>,
    },
    Detach,
}

/// Serves the control socket at `path` until a `detach` arrives. A detach
/// first calls `on_detach`, which unmounts or disconnects (so every write is
/// in the device), then snapshots, replies with the snapshot and returns.
pub fn serve(
    path: &Path,
    device: Arc<Device>,
    mut on_detach: impl FnMut() -> Result<()>,
) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    for stream in listener.incoming() {
        let stream = stream?;
        if handle(stream, &device, &mut on_detach)? {
            let _ = std::fs::remove_file(path);
            return Ok(());
        }
    }
    Ok(())
}

/// Answers one connection; true when it detached.
fn handle(
    stream: UnixStream,
    device: &Device,
    on_detach: &mut impl FnMut() -> Result<()>,
) -> Result<bool> {
    let mut writer = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let (reply, detach) = match serde_json::from_str::<Request>(&line) {
            Err(e) => (
                json!({ "ok": false, "error": format!("bad request: {e}") }),
                false,
            ),
            Ok(Request::Status) => (json!({ "ok": true, "status": device.status() }), false),
            Ok(Request::Sync) => (
                match device.sync() {
                    Ok(()) => json!({ "ok": true }),
                    Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
                },
                false,
            ),
            Ok(Request::Snapshot) => (result(device.snapshot()), false),
            Ok(Request::Fork { to, freeze }) => {
                (result(fork(device, &to, freeze.as_deref())), false)
            }
            Ok(Request::Detach) => match on_detach() {
                Ok(()) => (result(device.snapshot()), true),
                Err(e) => (
                    json!({ "ok": false, "error": format!("detaching: {e:#}") }),
                    false,
                ),
            },
        };
        writer.write_all(format!("{reply}\n").as_bytes())?;
        if detach {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fork(device: &Device, to: &str, freeze: Option<&str>) -> Result<volume::Hash> {
    let Some(mountpoint) = freeze else {
        return device.fork(to);
    };
    if fsfreeze("-f", mountpoint).is_ok() {
        let forked = device.fork(to);
        fsfreeze("-u", mountpoint)?;
        return forked;
    }
    // FUSE filesystems can't be frozen: sync them, so everything written
    // before the fork reaches the device.
    let status = crate::helper("sync").args(["-f", mountpoint]).status()?;
    if !status.success() {
        bail!("sync -f {mountpoint} failed: {status}");
    }
    device.fork(to)
}

fn fsfreeze(flag: &str, mountpoint: &str) -> Result<()> {
    let status = crate::helper("fsfreeze")
        .args([flag, mountpoint])
        .status()?;
    if !status.success() {
        bail!("fsfreeze {flag} {mountpoint} failed: {status}");
    }
    Ok(())
}

fn result(outcome: Result<volume::Hash>) -> serde_json::Value {
    match outcome {
        Ok(snapshot) => json!({ "ok": true, "snapshot": snapshot }),
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}
