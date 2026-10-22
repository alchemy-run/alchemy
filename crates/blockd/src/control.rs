//! The control socket: one JSON request per line, one JSON reply per line.
//!
//! ```text
//! {"op":"status"}
//! {"op":"sync"}                                   → {"ok":true}
//! {"op":"snapshot"}                               → {"ok":true,"snapshot":"…"}
//! {"op":"fork","to":"try-1","freeze":"/workspace"} → {"ok":true,"snapshot":"…"}
//! {"op":"detach"}                                → {"ok":true,"snapshot":"…","paths":[…]}
//! {"op":"checkpoint"}                            → {"ok":true,"paths":[…]}
//! {"op":"apply","patches":["patches/…"]}         → {"ok":true,"paths":[…],"applied":[…]}
//! ```
//!
//! `checkpoint` reports which paths the head changed since the last one
//! (`null`: unknown). `apply` takes a checkpoint, then applies patches from
//! the store to the mounted workspace; its own writes aren't reported by the
//! next checkpoint. A detach reports the last checkpoint's paths too.
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
    Snapshot {
        #[serde(default)]
        freeze: Option<String>,
    },
    Fork {
        to: String,
        freeze: Option<String>,
    },
    Detach,
    Checkpoint,
    Apply {
        patches: Vec<String>,
    },
}

/// What a mount adds to the control socket.
pub trait MountOps {
    /// Unmounts (or disconnects), so every write is in the device; returns
    /// fields for the detach's reply.
    fn detach(&mut self) -> Result<serde_json::Value>;
    fn checkpoint(&mut self) -> Result<serde_json::Value> {
        bail!("this attach has no mount to checkpoint")
    }
    fn apply(&mut self, _patches: &[String]) -> Result<serde_json::Value> {
        bail!("this attach has no mount to apply a patch to")
    }
}

/// A [`MountOps`] that only detaches.
pub struct DetachOnly<F: FnMut() -> Result<()>>(pub F);

impl<F: FnMut() -> Result<()>> MountOps for DetachOnly<F> {
    fn detach(&mut self) -> Result<serde_json::Value> {
        (self.0)()?;
        Ok(json!({}))
    }
}

/// Serves the control socket at `path` until a `detach` arrives. A detach
/// first calls `on_detach`, which unmounts or disconnects (so every write is
/// in the device), then snapshots, replies with the snapshot and returns.
pub fn serve(path: &Path, device: Arc<Device>, mut ops: impl MountOps) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    for stream in listener.incoming() {
        let stream = stream?;
        if handle(stream, &device, &mut ops)? {
            let _ = std::fs::remove_file(path);
            return Ok(());
        }
    }
    Ok(())
}

/// Answers one connection; true when it detached.
fn handle(stream: UnixStream, device: &Device, ops: &mut impl MountOps) -> Result<bool> {
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
            Ok(Request::Snapshot { freeze }) => (
                result(frozen(freeze.as_deref(), || device.snapshot())),
                false,
            ),
            Ok(Request::Fork { to, freeze }) => {
                (result(fork(device, &to, freeze.as_deref())), false)
            }
            Ok(Request::Detach) => match ops.detach() {
                Ok(extra) => {
                    let mut reply = result(device.snapshot());
                    merge(&mut reply, extra);
                    (reply, true)
                }
                Err(e) => (
                    json!({ "ok": false, "error": format!("detaching: {e:#}") }),
                    false,
                ),
            },
            Ok(Request::Checkpoint) => (outcome(ops.checkpoint()), false),
            Ok(Request::Apply { patches }) => (outcome(ops.apply(&patches)), false),
        };
        writer.write_all(format!("{reply}\n").as_bytes())?;
        if detach {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fork(device: &Device, to: &str, freeze: Option<&str>) -> Result<volume::Hash> {
    frozen(freeze, || device.fork(to))
}

/// Runs `take` (a snapshot) with the filesystem at `freeze` frozen, so the
/// snapshot is a clean point even while programs are writing.
pub(crate) fn frozen(freeze: Option<&str>, take: impl FnOnce() -> Result<volume::Hash>) -> Result<volume::Hash> {
    let Some(mountpoint) = freeze else {
        return take();
    };
    if fsfreeze("-f", mountpoint).is_ok() {
        let taken = take();
        fsfreeze("-u", mountpoint)?;
        return taken;
    }
    // FUSE filesystems can't be frozen: sync them, so everything written
    // before the snapshot reaches the device.
    let status = crate::helper("sync").args(["-f", mountpoint]).status()?;
    if !status.success() {
        bail!("sync -f {mountpoint} failed: {status}");
    }
    take()
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

fn outcome(outcome: Result<serde_json::Value>) -> serde_json::Value {
    match outcome {
        Ok(mut value) => {
            merge(&mut value, json!({ "ok": true }));
            value
        }
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}

fn merge(into: &mut serde_json::Value, extra: serde_json::Value) {
    if let (Some(into), serde_json::Value::Object(extra)) = (into.as_object_mut(), extra) {
        into.extend(extra);
    }
}

fn result(outcome: Result<volume::Hash>) -> serde_json::Value {
    match outcome {
        Ok(snapshot) => json!({ "ok": true, "snapshot": snapshot }),
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}
