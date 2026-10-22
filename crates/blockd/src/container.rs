//! Commands in a container: an OCI bundle run by `runc` (namespaces, the
//! host's kernel) or `runsc` (gVisor, a kernel in user space).
//!
//! The container's root is an image (a directory, often a read-only volume
//! blockd mounted) under an overlay whose upper layer is scratch space: a
//! command can write anywhere, and only the workspace persists. The
//! workspace (a mounted head or a call's fork) is bind-mounted at its path.
//!
//! The container's first process is blockd's own init (`blockd init`,
//! bind-mounted in), so it lives until it's destroyed: commands run in it
//! with `exec`, and processes they leave running keep running, the way they
//! would on a machine.

use crate::call::Run;
use crate::mount::User;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Which OCI runtime runs a container.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    /// `runc`: namespaces, seccomp, the host's kernel.
    Container,
    /// `runsc`: gVisor.
    Gvisor,
    /// A Firecracker microVM (`crate::vm`): hosts with KVM.
    Firecracker,
}

impl Runtime {
    fn program(self) -> &'static str {
        match self {
            Runtime::Container => "runc",
            Runtime::Gvisor => "runsc",
            Runtime::Firecracker => "firecracker",
        }
    }
}

/// Where a container's commands run, as a request names it.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Isolation {
    pub runtime: Runtime,
    /// The image: a directory to use as the root.
    pub rootfs: PathBuf,
    /// The image's block device, for a microVM's drive.
    #[serde(skip)]
    pub image_block: Option<PathBuf>,
    /// Where the workspace appears inside.
    pub path: String,
    /// Share the host's network (a container's own network is egress work, later).
    #[serde(default = "yes")]
    pub host_network: bool,
    /// Environment every command gets (the image's `ENV`).
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

fn yes() -> bool {
    true
}

/// A running container.
pub struct Container {
    id: String,
    runtime: Runtime,
    root: PathBuf,
    bundle: PathBuf,
    rootfs: PathBuf,
    path: String,
    env: Vec<(String, String)>,
    /// The container's init, as the host sees it (runc), or 1 (runsc).
    init: u32,
}

const PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

impl Container {
    /// Starts container `id` with `workspace` at `isolation.path`, its bundle
    /// and scratch space under `state`. `init` is a static blockd (it runs
    /// inside the image, whatever libc it has).
    pub fn start(
        id: &str,
        isolation: &Isolation,
        workspace: &Path,
        state: &Path,
        init: &Path,
    ) -> Result<Self> {
        let bundle = state.join(format!("bundle-{id}"));
        let _ = force_unmount(&bundle.join("rootfs"));
        let _ = force_unmount(&bundle.join("tmpfs"));
        let _ = std::fs::remove_dir_all(&bundle);
        let rootfs = bundle.join("rootfs");
        std::fs::create_dir_all(&rootfs)?;
        // The image under scratch space: writes anywhere, kept nowhere. The
        // scratch goes on this machine's disk, or on tmpfs where the disk
        // can't hold an overlay's upper layer (it's an overlay itself).
        let mut mounted = false;
        for scratch in [bundle.join("disk"), bundle.join("tmpfs")] {
            std::fs::create_dir_all(&scratch)?;
            if scratch.ends_with("tmpfs") {
                let status = crate::helper("mount")
                    .args(["-t", "tmpfs", "-o", "mode=0755", "tmpfs"])
                    .arg(&scratch)
                    .status()?;
                if !status.success() {
                    break;
                }
            }
            let (upper, work) = (scratch.join("upper"), scratch.join("work"));
            std::fs::create_dir_all(&upper)?;
            std::fs::create_dir_all(&work)?;
            let options = format!(
                "lowerdir={},upperdir={},workdir={},redirect_dir=off,metacopy=off,index=off,xino=off",
                isolation.rootfs.display(),
                upper.display(),
                work.display()
            );
            let status = crate::helper("mount")
                .args(["-t", "overlay", "overlay", "-o", &options])
                .arg(&rootfs)
                .stderr(Stdio::null())
                .status()?;
            if status.success() {
                mounted = true;
                break;
            }
        }
        if !mounted {
            let _ = force_unmount(&bundle.join("tmpfs"));
            bail!("mounting the image {} as an overlay failed", isolation.rootfs.display());
        }
        let config = config(isolation, workspace, &rootfs, init);
        std::fs::write(bundle.join("config.json"), serde_json::to_vec_pretty(&config)?)?;
        let root = state.join(format!("{}-root", isolation.runtime.program()));
        std::fs::create_dir_all(&root)?;
        let mut container = Self {
            id: id.to_string(),
            runtime: isolation.runtime,
            root,
            bundle,
            rootfs,
            path: isolation.path.clone(),
            env: isolation.env.clone(),
            init: 0,
        };
        let _ = container.runtime_command(&["delete", "--force", id]).output();
        let pid_file = container.bundle.join("init.pid");
        // Its output goes to a file: init inherits it, so a pipe would stay
        // open as long as the container lives.
        let log = container.bundle.join("runtime.log");
        let started = container
            .runtime_command(&["run", "--detach", "--bundle"])
            .arg(&container.bundle)
            .args(["--pid-file"])
            .arg(&pid_file)
            .arg(id)
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&log)?)
            .stderr(std::fs::OpenOptions::new().append(true).open(&log)?)
            .status()?;
        if !started.success() {
            let output = std::fs::read_to_string(&log).unwrap_or_default();
            let _ = force_unmount(&container.rootfs);
            let _ = force_unmount(&container.bundle.join("tmpfs"));
            bail!("{} run: {}", container.runtime.program(), output.trim());
        }
        container.init = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|pid| pid.trim().parse().ok())
            .unwrap_or(0);
        Ok(container)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn runtime_command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(self.runtime.program());
        command.arg("--root").arg(&self.root);
        if self.runtime == Runtime::Gvisor {
            // The container's cgroups are the host's business, not gVisor's.
            command.args(["--ignore-cgroups", "--overlay2=none", "--network=host"]);
        }
        command.args(args);
        command
    }

    /// `run.command` with `sh -c` inside, in the workspace (or `run.cwd`),
    /// ready to spawn: its output where `run` says.
    pub fn command(&self, run: &Run) -> Result<Command> {
        let cwd = match &run.cwd {
            Some(cwd) => cwd.display().to_string(),
            None => self.path.clone(),
        };
        let mut command = self.runtime_command(&["exec", "--cwd", &cwd]);
        let mut env: Vec<(String, String)> = vec![("PATH".into(), PATH.into()), ("HOME".into(), "/root".into())];
        env.extend(self.env.iter().cloned());
        env.extend(run.env.iter().cloned());
        for (name, value) in &env {
            command.arg("--env").arg(format!("{name}={value}"));
        }
        command.args([&self.id, "/bin/sh", "-c", &run.command]);
        command.stdin(Stdio::null());
        if let Some(stdout) = &run.stdout {
            command.stdout(stdout.try_clone()?);
        }
        if let Some(stderr) = &run.stderr {
            command.stderr(stderr.try_clone()?);
        }
        Ok(command)
    }

    /// Runs `run.command` inside and waits for it. Returns its exit code and
    /// whether it timed out.
    pub fn exec(&self, run: &Run) -> Result<(i32, bool)> {
        let mut child = self.command(run)?.spawn().context("starting the command in its container")?;
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok((status.code().unwrap_or(128), false));
            }
            if run.timeout.is_some_and(|t| started.elapsed() >= t) {
                let _ = child.kill();
                let _ = child.wait();
                // What it started inside goes too.
                self.stop_others();
                return Ok((124, true));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Processes running in the container other than its init.
    pub fn processes(&self) -> Vec<User> {
        match self.runtime {
            // runc's are host processes in the container's PID namespace
            // (its `ps` reads cgroups, which nested hosts don't always allow).
            Runtime::Container => {
                let Ok(namespace) = std::fs::read_link(format!("/proc/{}/ns/pid", self.init)) else {
                    return Vec::new();
                };
                let mut found = Vec::new();
                for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
                    let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
                        continue;
                    };
                    if pid == self.init
                        || std::fs::read_link(entry.path().join("ns/pid")).ok().as_ref() != Some(&namespace)
                    {
                        continue;
                    }
                    let command = command_line(pid);
                    if !command.is_empty() {
                        found.push(User { pid, command });
                    }
                }
                found
            }
            Runtime::Firecracker => Vec::new(),
            // runsc lists the sandbox's own processes (its JSON is pids alone;
            // the table has each one's command).
            Runtime::Gvisor => {
                let Ok(output) = self.runtime_command(&["ps", &self.id]).output() else {
                    return Vec::new();
                };
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .skip(1)
                    .filter_map(|line| {
                        let columns: Vec<&str> = line.split_whitespace().collect();
                        let pid: u32 = columns.get(1)?.parse().ok()?;
                        let command = columns.get(8..)?.join(" ");
                        (pid > 1 && !command.is_empty()).then_some(User { pid, command })
                    })
                    .collect()
            }
        }
    }

    /// Kills every process but init; returns them.
    pub fn stop_others(&self) -> Vec<User> {
        let running = self.processes();
        for process in &running {
            match self.runtime {
                Runtime::Container => unsafe {
                    libc::kill(process.pid as i32, libc::SIGKILL);
                },
                Runtime::Gvisor => {
                    let _ = self
                        .runtime_command(&["kill", "--pid", &process.pid.to_string(), &self.id, "KILL"])
                        .output();
                }
                Runtime::Firecracker => {}
            }
        }
        for _ in 0..50 {
            if self.processes().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        running
    }

    /// Kills everything in it and removes it.
    pub fn destroy(&self) -> Result<()> {
        let deleted = self.runtime_command(&["delete", "--force", &self.id]).output()?;
        if !deleted.status.success() {
            tracing::warn!(
                "{} delete {}: {}",
                self.runtime.program(),
                self.id,
                String::from_utf8_lossy(&deleted.stderr).trim()
            );
        }
        force_unmount(&self.rootfs)?;
        force_unmount(&self.bundle.join("tmpfs"))?;
        let _ = std::fs::remove_dir_all(&self.bundle);
        Ok(())
    }
}

fn force_unmount(dir: &Path) -> Result<()> {
    if mounted_at(dir) {
        let status = crate::helper("umount").arg("-l").arg(dir).status()?;
        if !status.success() {
            bail!("umount {} failed", dir.display());
        }
    }
    Ok(())
}

/// Whether something is mounted at `dir`.
fn mounted_at(dir: &Path) -> bool {
    let Ok(dir) = std::fs::canonicalize(dir) else {
        return false;
    };
    std::fs::read_to_string("/proc/self/mountinfo").is_ok_and(|mounts| {
        mounts
            .lines()
            .filter_map(|line| line.split(' ').nth(4))
            .any(|point| Path::new(&point.replace("\\040", " ")) == dir)
    })
}

fn command_line(pid: u32) -> String {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .split('\0')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// The OCI config: Docker's defaults where it has them.
fn config(isolation: &Isolation, workspace: &Path, rootfs: &Path, init: &Path) -> Value {
    let capabilities = [
        "CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FSETID", "CAP_FOWNER", "CAP_MKNOD", "CAP_NET_RAW",
        "CAP_SETGID", "CAP_SETUID", "CAP_SETFCAP", "CAP_SETPCAP", "CAP_NET_BIND_SERVICE",
        "CAP_SYS_CHROOT", "CAP_KILL", "CAP_AUDIT_WRITE",
    ];
    let mut namespaces = vec![json!({"type":"pid"}), json!({"type":"ipc"}), json!({"type":"uts"}), json!({"type":"mount"})];
    if !isolation.host_network {
        namespaces.push(json!({"type":"network"}));
    }
    let mut mounts = vec![
        json!({"destination":"/proc","type":"proc","source":"proc"}),
        json!({"destination":"/dev","type":"tmpfs","source":"tmpfs","options":["nosuid","strictatime","mode=755","size=65536k"]}),
        json!({"destination":"/dev/pts","type":"devpts","source":"devpts","options":["nosuid","noexec","newinstance","ptmxmode=0666","mode=0620","gid=5"]}),
        json!({"destination":"/dev/shm","type":"tmpfs","source":"shm","options":["nosuid","noexec","nodev","mode=1777","size=65536k"]}),
        json!({"destination":"/dev/mqueue","type":"mqueue","source":"mqueue","options":["nosuid","noexec","nodev"]}),
        json!({"destination":"/sys","type":"sysfs","source":"sysfs","options":["nosuid","noexec","nodev","ro"]}),
        json!({"destination":&isolation.path,"type":"bind","source":workspace,"options":["rbind","rw"]}),
        json!({"destination":"/.blockd/init","type":"bind","source":init,"options":["bind","ro"]}),
    ];
    if isolation.host_network {
        for file in ["/etc/resolv.conf", "/etc/hosts"] {
            if Path::new(file).exists() {
                mounts.push(json!({"destination":file,"type":"bind","source":file,"options":["bind","ro"]}));
            }
        }
    }
    json!({
        "ociVersion": "1.0.2",
        "process": {
            "terminal": false,
            "user": {"uid": 0, "gid": 0},
            "args": ["/.blockd/init", "init"],
            "env": [format!("PATH={PATH}")],
            "cwd": "/",
            "capabilities": {
                "bounding": capabilities, "effective": capabilities,
                "permitted": capabilities,
            },
            "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 1048576u64, "soft": 1048576u64}],
            "noNewPrivileges": true,
        },
        "root": {"path": rootfs, "readonly": false},
        "hostname": "workspace",
        "mounts": mounts,
        "linux": {
            "namespaces": namespaces,
            "maskedPaths": [
                "/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats",
                "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/sys/firmware",
                "/proc/scsi",
            ],
            "readonlyPaths": [
                "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger",
            ],
        },
    })
}

/// `blockd init`: a container's first process. Reaps whatever is orphaned
/// to it, and exits on SIGTERM or SIGINT.
pub fn init() -> ! {
    unsafe {
        libc::signal(libc::SIGTERM, exit_now as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, exit_now as *const () as libc::sighandler_t);
    }
    loop {
        let mut status = 0;
        let reaped = unsafe { libc::waitpid(-1, &mut status, 0) };
        if reaped < 0 {
            // No children yet: orphans arrive whenever a command's shell exits.
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

extern "C" fn exit_now(_: libc::c_int) {
    unsafe { libc::_exit(0) };
}
