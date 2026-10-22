//! Commands in a Firecracker microVM: a hardware boundary, for hosts with
//! KVM. The VM boots blockd's guest agent ([`crate::guest`]) from an
//! initramfs holding just a static blockd, with two read-only drives: the
//! image and the workspace's snapshot. The agent runs commands and makes the
//! patch; this side starts the VM and talks to the agent over vsock.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
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
}

impl Vm {
    /// Boots a VM in `dir` with `drives` (path, read-only), and waits for its
    /// agent. `path` is where the workspace appears inside.
    pub fn start(
        firecracker: &Firecracker,
        dir: &Path,
        drives: &[(&Path, bool)],
        path: &str,
    ) -> Result<Self> {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir)?;
        let initrd = dir.join("initrd.cpio");
        std::fs::write(&initrd, initramfs(&std::fs::read(&firecracker.init)?))?;
        let vsock = dir.join("vsock.sock");
        let config = json!({
            "boot-source": {
                "kernel_image_path": firecracker.kernel,
                "initrd_path": initrd,
                "boot_args": format!("console=ttyS0 reboot=k panic=1 pci=off quiet rdinit=/init alchemy.path={path}"),
            },
            "drives": drives.iter().enumerate().map(|(i, (drive, readonly))| json!({
                "drive_id": format!("drive{i}"),
                "path_on_host": drive,
                "is_root_device": false,
                "is_read_only": readonly,
            })).collect::<Vec<_>>(),
            "machine-config": {
                "vcpu_count": firecracker.vcpus,
                "mem_size_mib": firecracker.memory_mib,
            },
            "vsock": { "guest_cid": 3, "uds_path": vsock },
        });
        let config_path = dir.join("config.json");
        std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
        let log = std::fs::File::create(dir.join("console.log"))?;
        let child = Command::new(&firecracker.binary)
            .arg("--api-sock")
            .arg(dir.join("api.sock"))
            .arg("--config-file")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()
            .context("starting firecracker")?;
        let mut vm = Self {
            dir: dir.to_path_buf(),
            child,
            vsock,
        };
        // The agent answers once the VM has booted and mounted its drives.
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = vm.child.try_wait() {
                bail!("the microVM exited ({status}): {}", vm.console());
            }
            if vm.request(&json!({ "op": "ping" })).is_ok() {
                return Ok(vm);
            }
            if started.elapsed() > Duration::from_secs(30) {
                let console = vm.console();
                vm.stop();
                bail!("the microVM's agent never answered: {console}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
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
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        self.stop();
    }
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
