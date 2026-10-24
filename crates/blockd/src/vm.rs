//! Commands in a Firecracker microVM: a hardware boundary, for hosts with
//! KVM. The VM boots blockd's guest agent ([`crate::guest`]) from an
//! initramfs holding just a static blockd, with two read-only drives: the
//! image and the workspace's snapshot. The agent runs commands and makes the
//! patch; this side starts the VM and talks to the agent over vsock.
//!
//! Booting takes a few hundred milliseconds, most of it the kernel's. A
//! [`Template`] boots once and snapshots the VM as its agent starts
//! listening; a call restores that snapshot instead. The VM's paths (its
//! drives, its vsock) are relative, so a restore in a call's own directory
//! finds that call's disks, and the snapshot's memory is mapped privately,
//! so one file serves every VM restored from it.

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What a host needs to run microVMs.
#[derive(Clone, Debug)]
pub struct Firecracker {
    /// The `firecracker` binary.
    pub binary: PathBuf,
    /// An uncompressed guest kernel (`vmlinux`).
    pub kernel: PathBuf,
    /// A static blockd: the guest's `/init`.
    pub init: PathBuf,
    pub vcpus: u32,
    pub memory_mib: u32,
}

/// A running microVM.
pub struct Vm {
    dir: PathBuf,
    child: Child,
    vsock: PathBuf,
    /// Its tap on the host's bridge, released with it.
    lease: Option<crate::net::Lease>,
}

/// A VM's network interface, as Firecracker configures it.
struct Nic<'a> {
    tap: &'a str,
    mac: String,
}

/// The drives every VM has, by the names its paths use.
const DRIVES: [&str; 2] = ["image", "workspace"];

/// A booted VM, snapshotted as its agent listens: what calls restore.
pub struct Template {
    dir: PathBuf,
    /// Whether it has a network interface: restores then need a tap.
    nic: bool,
}

impl Template {
    /// Boots a VM in `dir` on placeholder drives (and a tap on `networks`,
    /// for its interface), and snapshots it.
    pub fn make(firecracker: &Firecracker, dir: &Path, networks: Option<&std::sync::Arc<crate::net::Networks>>) -> Result<Self> {
        let lease = networks.map(|networks| networks.tap(&[])).transpose()?;
        let placeholders: Vec<PathBuf> = DRIVES.iter().map(|name| dir.with_extension(format!("{name}.placeholder"))).collect();
        for placeholder in &placeholders {
            std::fs::File::create(placeholder)?.set_len(1024 * 1024)?;
        }
        let drives: Vec<(&Path, bool)> = placeholders.iter().map(|p| (p.as_path(), true)).collect();
        let nic = lease.as_ref().map(|lease| Nic { tap: lease.tap.as_deref().unwrap_or_default(), mac: lease.mac() });
        let mut vm = Vm::boot(firecracker, dir, &drives, nic.as_ref())?;
        let api = dir.join("api.sock");
        api_call(&api, "PATCH", "/vm", &json!({ "state": "Paused" }))?;
        api_call(
            &api,
            "PUT",
            "/snapshot/create",
            &json!({
                "snapshot_type": "Full",
                "snapshot_path": dir.join("vmstate"),
                "mem_file_path": dir.join("memory"),
            }),
        )?;
        let _ = vm.child.kill();
        let _ = vm.child.wait();
        std::mem::forget(vm); // keeps the snapshot's directory
        Ok(Self { dir: dir.to_path_buf(), nic: lease.is_some() })
    }
}

impl Vm {
    /// Boots a VM in `dir` with `drives` (path, read-only) and starts its
    /// agent on them. `path` is where the workspace appears inside; `lease`,
    /// its network (handed to the VM with [`Vm::hold`]).
    pub fn start(
        firecracker: &Firecracker,
        dir: &Path,
        drives: &[(&Path, bool)],
        path: &str,
        lease: Option<&crate::net::Lease>,
    ) -> Result<Self> {
        let nic = lease.map(|lease| Nic { tap: lease.tap.as_deref().unwrap_or_default(), mac: lease.mac() });
        let vm = Self::boot(firecracker, dir, drives, nic.as_ref())?;
        vm.begin(drives, path, lease)?;
        Ok(vm)
    }

    /// The VM keeps `lease` (its tap) until it stops.
    pub fn hold(&mut self, lease: crate::net::Lease) {
        self.lease = Some(lease);
    }

    /// Restores `template` in `dir` on `drives`, and starts its agent on them.
    pub fn restore(
        firecracker: &Firecracker,
        template: &Template,
        dir: &Path,
        drives: &[(&Path, bool)],
        path: &str,
        lease: Option<&crate::net::Lease>,
    ) -> Result<Self> {
        if template.nic != lease.is_some() {
            bail!("the template's network interface doesn't match the call's");
        }
        let mut vm = Self::spawn(firecracker, dir, drives, None)?;
        let api = dir.join("api.sock");
        let started = Instant::now();
        while !api.exists() {
            if started.elapsed() > Duration::from_secs(5) {
                bail!("firecracker never listened: {}", vm.console());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let restored = (|| -> Result<()> {
            api_call(
                &api,
                "PUT",
                "/snapshot/load",
                &json!({
                    "snapshot_path": template.dir.join("vmstate"),
                    "mem_backend": { "backend_type": "File", "backend_path": template.dir.join("memory") },
                    "resume_vm": true,
                    // The call's own tap, not the template's.
                    "network_overrides": lease
                        .and_then(|lease| lease.tap.as_deref())
                        .map(|tap| vec![json!({ "iface_id": "eth0", "host_dev_name": tap })])
                        .unwrap_or_default(),
                }),
            )?;
            // The drives are opened again, so the guest learns their sizes.
            for (i, name) in DRIVES.iter().enumerate() {
                api_call(&api, "PATCH", &format!("/drives/drive{i}"), &json!({ "drive_id": format!("drive{i}"), "path_on_host": name }))?;
            }
            vm.wait_for_agent()
        })();
        if let Err(e) = restored {
            let console = vm.console();
            vm.stop();
            return Err(e.context(console));
        }
        vm.begin(drives, path, lease)?;
        Ok(vm)
    }

    /// A VM booted in `dir`, its agent listening (not yet started).
    fn boot(firecracker: &Firecracker, dir: &Path, drives: &[(&Path, bool)], nic: Option<&Nic>) -> Result<Self> {
        let config = json!({
            "boot-source": {
                "kernel_image_path": firecracker.kernel,
                "initrd_path": "initrd.cpio",
                "boot_args": "console=ttyS0 reboot=k panic=1 pci=off quiet rdinit=/init",
            },
            "drives": drives.iter().enumerate().map(|(i, (_, readonly))| json!({
                "drive_id": format!("drive{i}"),
                "path_on_host": DRIVES[i],
                "is_root_device": false,
                "is_read_only": readonly,
            })).collect::<Vec<_>>(),
            "machine-config": {
                "vcpu_count": firecracker.vcpus,
                "mem_size_mib": firecracker.memory_mib,
            },
            "vsock": { "guest_cid": 3, "uds_path": "vsock.sock" },
            "network-interfaces": nic.map(|nic| vec![json!({
                "iface_id": "eth0",
                "host_dev_name": nic.tap,
                "guest_mac": nic.mac,
            })]).unwrap_or_default(),
        });
        let mut vm = Self::spawn(firecracker, dir, drives, Some(&config))?;
        if let Err(e) = vm.wait_for_agent() {
            vm.stop();
            return Err(e);
        }
        Ok(vm)
    }

    /// Firecracker in a fresh `dir` holding the VM's drives (links to
    /// `drives`), with `config`, or waiting on its API for a snapshot.
    fn spawn(firecracker: &Firecracker, dir: &Path, drives: &[(&Path, bool)], config: Option<&Value>) -> Result<Self> {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir)?;
        for (i, (drive, _)) in drives.iter().enumerate() {
            std::os::unix::fs::symlink(drive, dir.join(DRIVES[i]))?;
        }
        let mut command = Command::new(&firecracker.binary);
        command.current_dir(dir).arg("--api-sock").arg("api.sock");
        if let Some(config) = config {
            std::fs::write(dir.join("initrd.cpio"), initramfs(&std::fs::read(&firecracker.init)?))?;
            std::fs::write(dir.join("config.json"), serde_json::to_vec_pretty(config)?)?;
            command.arg("--config-file").arg("config.json");
        }
        let log = std::fs::File::create(dir.join("console.log"))?;
        let child = command
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()
            .context("starting firecracker")?;
        Ok(Self {
            dir: dir.to_path_buf(),
            child,
            vsock: dir.join("vsock.sock"),
            lease: None,
        })
    }

    /// Until the agent answers.
    fn wait_for_agent(&mut self) -> Result<()> {
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                bail!("the microVM exited ({status}): {}", self.console());
            }
            if self.request(&json!({ "op": "ping" })).is_ok() {
                return Ok(());
            }
            if started.elapsed() > Duration::from_secs(30) {
                bail!("the microVM's agent never answered: {}", self.console());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// The agent mounts `drives` (their sizes, so it waits for them) at
    /// `path`, and configures `lease`'s network.
    fn begin(&self, drives: &[(&Path, bool)], path: &str, lease: Option<&crate::net::Lease>) -> Result<()> {
        let mut sectors = Vec::new();
        for (drive, _) in drives {
            let mut file = std::fs::File::open(drive).with_context(|| format!("opening {}", drive.display()))?;
            sectors.push(std::io::Seek::seek(&mut file, std::io::SeekFrom::End(0))? / 512);
        }
        let mut entropy = [0u8; 64];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut entropy)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
        self.request(&json!({
            "op": "start",
            "path": path,
            "sectors": sectors,
            "timeNs": now.as_nanos() as u64,
            "entropy": base64::engine::general_purpose::STANDARD.encode(entropy),
            "network": lease.map(|lease| json!({
                "mac": lease.mac(),
                "address": lease.address.to_string(),
                "prefix": lease.prefix(),
                "gateway": lease.gateway().to_string(),
                "resolvConf": lease.resolv_conf(),
            })),
        }))
        .map(|_| ())
    }

    /// What the VM printed (its kernel and agent), for errors.
    pub fn console(&self) -> String {
        let text = std::fs::read_to_string(self.dir.join("console.log")).unwrap_or_default();
        text.chars().rev().take(3000).collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// One request to the agent.
    pub fn request(&self, request: &Value) -> Result<Value> {
        let mut stream = UnixStream::connect(&self.vsock)?;
        // Firecracker's vsock: name the guest's port, then it's a stream.
        stream.write_all(format!("CONNECT {}\n", crate::guest::PORT).as_bytes())?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut ack = String::new();
        reader.read_line(&mut ack)?;
        if !ack.starts_with("OK") {
            bail!("vsock: {ack:?}");
        }
        stream.write_all(format!("{request}\n").as_bytes())?;
        let mut reply = String::new();
        reader.read_line(&mut reply)?;
        let reply: Value = serde_json::from_str(&reply).context("the agent's reply")?;
        if reply["ok"] != Value::Bool(true) {
            bail!("the agent: {}", reply["error"].as_str().unwrap_or("failed"));
        }
        Ok(reply)
    }

    /// Kills the VM.
    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.lease = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One request to Firecracker's API, on its socket: fails unless it's 2xx.
fn api_call(socket: &Path, method: &str, path: &str, body: &Value) -> Result<()> {
    let mut stream = UnixStream::connect(socket).with_context(|| format!("firecracker's API at {}", socket.display()))?;
    let body = body.to_string();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\naccept: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )?;
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status)?;
    let code: u16 = status.split(' ').nth(1).and_then(|c| c.parse().ok()).with_context(|| format!("firecracker said {status:?}"))?;
    let mut length = 0;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut reply = vec![0; length];
    reader.read_exact(&mut reply)?;
    if !(200..300).contains(&code) {
        bail!("firecracker: {method} {path}: {code} {}", String::from_utf8_lossy(&reply));
    }
    Ok(())
}

/// An initramfs (cpio, newc) holding `init` as `/init`, `/dev/console` for
/// its output, and the directories the agent mounts on.
fn initramfs(init: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut ino = 1u32;
    let mut entry = |out: &mut Vec<u8>, name: &str, mode: u32, rdev: (u32, u32), data: &[u8]| {
        let header = format!(
            "070701{ino:08x}{mode:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}",
            0, 0, 1, 0, data.len(), 0, 0, rdev.0, rdev.1, name.len() + 1, 0
        );
        ino += 1;
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
        out.extend_from_slice(data);
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
    };
    for dir in ["dev", "proc", "sys", "image", "base", "rw", "newroot", "tmp"] {
        entry(&mut out, dir, 0o040755, (0, 0), &[]);
    }
    entry(&mut out, "dev/console", 0o020600, (5, 1), &[]);
    entry(&mut out, "init", 0o100755, (0, 0), init);
    entry(&mut out, "TRAILER!!!", 0, (0, 0), &[]);
    out
}
