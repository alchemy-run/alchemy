//! `blockd guest`: the first process of a Firecracker microVM a call runs
//! in. The host hands the VM two drives, both read-only: the image (`vda`)
//! and the workspace's snapshot (`vdb`). Each is mounted under an overlay
//! whose upper layer is the VM's memory, so the command can write anywhere
//! and the host's disks are never written. The workspace's overlay is at the
//! workspace's path; the patch of what the command changed is made here,
//! from its upper layer, as `blockd call` makes it on a host.
//!
//! The host talks to it over vsock (port [`PORT`]): one JSON request per line,
//! one JSON reply per line.
//!
//! ```text
//! {"op":"ping"}                                         → {"ok":true}
//! {"op":"exec","command":…,"cwd":…,"env":{…},"timeoutMs":…} → {"exitCode":…,"timedOut":…,"stdout":…,"stderr":…}
//! {"op":"processes"}                                    → {"processes":[{pid, command}]}
//! {"op":"stop"}                                         → {"stopped":[…]}  (everything the commands left)
//! {"op":"commit","full":false}                           → {"summary":…,"patch":<base64>}
//! ```

use crate::call::OverlayCommits;
use crate::mount::User;
use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The vsock port the agent listens on.
pub const PORT: u32 = 1024;

const ROOT: &str = "/newroot";
const IMAGE: &str = "/image";
const BASE: &str = "/base";
const MEMORY: &str = "/rw";
const PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// The workspace's path, from the kernel's command line (`alchemy.path=…`).
fn workspace_path() -> String {
    std::fs::read_to_string("/proc/cmdline")
        .ok()
        .and_then(|line| {
            line.split_whitespace()
                .find_map(|arg| arg.strip_prefix("alchemy.path=").map(str::to_string))
        })
        .unwrap_or_else(|| "/workspace".into())
}

fn sh(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status()?;
    if !status.success() {
        bail!("{program} {} failed: {status}", args.join(" "));
    }
    Ok(())
}

fn mount(kind: &str, source: &str, target: &str, options: &str) -> Result<()> {
    std::fs::create_dir_all(target)?;
    let mut args = vec!["-t", kind];
    if !options.is_empty() {
        args.extend(["-o", options]);
    }
    args.extend([source, target]);
    sh("/bin/mount", &args).or_else(|_| mount_syscall(kind, source, target, options))
}

/// The initramfs has no `mount` binary: the syscall itself.
fn mount_syscall(kind: &str, source: &str, target: &str, options: &str) -> Result<()> {
    use std::ffi::CString;
    let flags = if options.split(',').any(|o| o == "ro") { libc::MS_RDONLY } else { 0 };
    let data: String = options.split(',').filter(|o| *o != "ro").collect::<Vec<_>>().join(",");
    let (source, target, kind, data) = (
        CString::new(source)?,
        CString::new(target)?,
        CString::new(kind)?,
        CString::new(data)?,
    );
    let rc = unsafe {
        libc::mount(source.as_ptr(), target.as_ptr(), kind.as_ptr(), flags, data.as_ptr().cast())
    };
    if rc != 0 {
        bail!("mounting {:?} at {:?}: {}", source, target, std::io::Error::last_os_error());
    }
    Ok(())
}

/// The VM's filesystems: the image and the workspace, each over memory.
fn prepare(path: &str) -> Result<()> {
    mount("proc", "proc", "/proc", "")?;
    mount("sysfs", "sysfs", "/sys", "")?;
    mount("devtmpfs", "devtmpfs", "/dev", "")?;
    mount("tmpfs", "tmpfs", MEMORY, "mode=0755")?;
    for dir in ["root-upper", "root-work", "ws-upper", "ws-work"] {
        std::fs::create_dir_all(Path::new(MEMORY).join(dir))?;
    }
    mount("ext4", "/dev/vda", IMAGE, "ro,noload")?;
    mount(
        "overlay",
        "overlay",
        ROOT,
        &format!("lowerdir={IMAGE},upperdir={MEMORY}/root-upper,workdir={MEMORY}/root-work"),
    )?;
    mount("ext4", "/dev/vdb", BASE, "ro,noload")?;
    let workspace = format!("{ROOT}{path}");
    mount(
        "overlay",
        "overlay",
        &workspace,
        &format!(
            "lowerdir={BASE},upperdir={MEMORY}/ws-upper,workdir={MEMORY}/ws-work,redirect_dir=off,metacopy=off,index=off,xino=off"
        ),
    )?;
    for (kind, target) in [("proc", "proc"), ("sysfs", "sys"), ("devtmpfs", "dev"), ("tmpfs", "tmp")] {
        let _ = mount(kind, kind, &format!("{ROOT}/{target}"), "");
    }
    Ok(())
}

/// Processes other than this one and the kernel's: what the commands started.
fn processes() -> Vec<User> {
    let me = std::process::id();
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        if pid == me || pid == 1 {
            continue;
        }
        let command = std::fs::read(entry.path().join("cmdline"))
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .split('\0')
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        // Kernel threads have no command line.
        if !command.is_empty() {
            found.push(User { pid, command });
        }
    }
    found
}

fn exec(request: &Value, path: &str) -> Result<Value> {
    use std::os::unix::process::CommandExt;
    let command = request["command"].as_str().context("`command`")?.to_string();
    let cwd = request["cwd"].as_str().map(str::to_string).unwrap_or_else(|| path.to_string());
    let timeout = request["timeoutMs"].as_u64().map(Duration::from_millis);
    let mut child = Command::new("/bin/sh");
    child
        .args(["-c", &command])
        .env_clear()
        .env("PATH", PATH)
        .env("HOME", "/root")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = request["env"].as_object() {
        for (name, value) in env {
            if let Some(value) = value.as_str() {
                child.env(name, value);
            }
        }
    }
    let cwd_in_root = cwd.clone();
    unsafe {
        child.pre_exec(move || {
            let root = std::ffi::CString::new(ROOT).unwrap();
            if libc::chroot(root.as_ptr()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let dir = std::ffi::CString::new(cwd_in_root.as_str()).unwrap();
            if libc::chdir(dir.as_ptr()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = child.spawn().context("starting the command")?;
    let pid = child.id() as i32;
    let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stderr, &mut bytes);
        bytes
    });
    let started = Instant::now();
    let (code, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code().unwrap_or(128), false);
        }
        if timeout.is_some_and(|t| started.elapsed() >= t) {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            let _ = child.wait();
            break (124, true);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let encode = |bytes: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(bytes);
    // A process the command left running holds its pipes: output so far.
    let stdout = if out.is_finished() { out.join().unwrap_or_default() } else { Vec::new() };
    let stderr = if err.is_finished() { err.join().unwrap_or_default() } else { Vec::new() };
    Ok(json!({ "exitCode": code, "timedOut": timed_out, "stdout": encode(stdout), "stderr": encode(stderr) }))
}

fn stop() -> Vec<User> {
    let running = processes();
    for process in &running {
        unsafe { libc::kill(process.pid as i32, libc::SIGKILL) };
    }
    std::thread::sleep(Duration::from_millis(50));
    running
}

fn handle(request: &Value, path: &str, commits: &Mutex<OverlayCommits>) -> Value {
    let outcome: Result<Value> = (|| match request["op"].as_str().unwrap_or("") {
        "ping" => Ok(json!({})),
        "exec" => exec(request, path),
        "processes" => Ok(json!({ "processes": processes() })),
        "stop" => Ok(json!({ "stopped": stop() })),
        "commit" => {
            let full = request["full"].as_bool().unwrap_or(false);
            let workspace = PathBuf::from(format!("{ROOT}{path}"));
            unsafe { libc::sync() };
            let mut bytes = Vec::new();
            let summary = commits.lock().unwrap().commit(
                Path::new(BASE),
                &workspace,
                &Path::new(MEMORY).join("ws-upper"),
                Some(&mut bytes),
                full,
            )?;
            Ok(json!({
                "summary": summary,
                "patch": base64::engine::general_purpose::STANDARD.encode(bytes),
            }))
        }
        other => bail!("no operation {other:?}"),
    })();
    match outcome {
        Ok(mut value) => {
            if let Some(object) = value.as_object_mut() {
                object.insert("ok".into(), Value::Bool(true));
            }
            value
        }
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}

/// Listens on vsock port `port` for any host CID.
fn listen(port: u32) -> Result<i32> {
    #[repr(C)]
    struct SockaddrVm {
        family: libc::sa_family_t,
        reserved: u16,
        port: u32,
        cid: u32,
        flags: u8,
        zero: [u8; 3],
    }
    const AF_VSOCK: i32 = 40;
    let fd = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        bail!("vsock socket: {}", std::io::Error::last_os_error());
    }
    let address = SockaddrVm {
        family: AF_VSOCK as libc::sa_family_t,
        reserved: 0,
        port,
        cid: u32::MAX, // VMADDR_CID_ANY
        flags: 0,
        zero: [0; 3],
    };
    let rc = unsafe {
        libc::bind(
            fd,
            (&address as *const SockaddrVm).cast(),
            std::mem::size_of::<SockaddrVm>() as libc::socklen_t,
        )
    };
    if rc != 0 || unsafe { libc::listen(fd, 16) } != 0 {
        bail!("vsock bind/listen: {}", std::io::Error::last_os_error());
    }
    Ok(fd)
}

/// The guest's first process: never returns.
pub fn run() -> ! {
    let path = {
        // /proc isn't mounted yet: mount it to read the command line.
        let _ = std::fs::create_dir_all("/proc");
        let _ = mount_syscall("proc", "proc", "/proc", "");
        workspace_path()
    };
    let _ = unsafe { libc::umount2(c"/proc".as_ptr(), libc::MNT_DETACH) };
    if let Err(e) = prepare(&path) {
        eprintln!("blockd guest: {e:#}");
        unsafe { libc::reboot(libc::RB_POWER_OFF) };
    }
    // Orphans are reaped, so a stopped process doesn't linger as a zombie.
    std::thread::spawn(|| loop {
        let mut status = 0;
        if unsafe { libc::waitpid(-1, &mut status, libc::__WALL) } < 0 {
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let fd = match listen(PORT) {
        Ok(fd) => fd,
        Err(e) => {
            eprintln!("blockd guest: {e:#}");
            unsafe { libc::reboot(libc::RB_POWER_OFF) };
            unreachable!()
        }
    };
    let commits = std::sync::Arc::new(Mutex::new(OverlayCommits::default()));
    loop {
        let conn = unsafe { libc::accept4(fd, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
        if conn < 0 {
            continue;
        }
        let stream = unsafe { std::net::TcpStream::from_raw_fd(conn) };
        let (path, commits) = (path.clone(), commits.clone());
        std::thread::spawn(move || {
            let Ok(mut writer) = stream.try_clone() else { return };
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { return };
                if line.trim().is_empty() {
                    continue;
                }
                let reply = match serde_json::from_str::<Value>(&line) {
                    Ok(request) => handle(&request, &path, &commits),
                    Err(e) => json!({ "ok": false, "error": format!("bad request: {e}") }),
                };
                if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
                    return;
                }
            }
        });
    }
}
