//! ```text
//! blockd create  --store <spec> --head <name> --size <bytes>
//! blockd import  --store <spec> --head <name> --image <file>
//! blockd fork    --store <spec> --from <head> --to <head>
//! blockd reset   --store <spec> --head <name> --to <snapshot>
//! blockd drop    --store <spec> --head <name>
//! blockd export  --store <spec> --head <name> --image <file>   (write the head as a sparse image)
//! blockd gc      --store <spec> [--history <n>] [--grace-seconds <s>] [--dry-run true]
//! blockd heads   --store <spec>
//! blockd history --store <spec> --head <name> [--limit <n>]
//! blockd attach  --store <spec> --head <name> --cache <file> (--nbd /dev/nbd0 | --ublk <id>)
//!                [--control <socket>] [--flush-every <seconds>] [--prefetch true]
//!                (a raw block device; mounting it is up to you)
//! blockd mount   --store <spec> --head <name> --cache <file> --dir <dir> --control <socket>
//!                [--mode auto|ublk|nbd|loop|fuse] [--flush-every <seconds>] [--prefetch true]
//!                (mount in the best mode the host allows and print {"mounted":…} when ready;
//!                 a detach on the control socket unmounts, snapshots and exits)
//! blockd exec    --store <spec> --head <name> --cache <file> --dir <dir> --command <sh> [--mode …]
//!                (mount, run, unmount, snapshot; exits with the command's code)
//! blockd call    --store <spec> --snapshot <id> --cache <file> --dir <dir> --work <dir> --command <sh>
//!                [--cwd <dir>] [--env <json>] [--timeout-ms <n>] [--patch <key>]
//!                [--result <file>] [--mode …] [--keep true --control <socket>]
//!                (run a command on an ephemeral fork of a snapshot and make a patch of what it
//!                 changed, uploaded to the store as <key>; --keep keeps processes it left
//!                 running, with the fork, until a detach on the control socket)
//! blockd diff    --store <spec> --from <id> --to <id> --cache <file> --cache-to <file> --work <dir>
//!                (--patch <key> | --patch-file <file>)   (a patch from one snapshot to another)
//! blockd apply   --dir <dir> --patch-file <file>     (apply a patch to a directory)
//! blockd daemon  [--listen <host:port>] [--socket <path>] [--pidfile <file>]
//!                [--state /var/cache/blockd] [--run /run/blockd]
//!                (every head, call and cache on this machine, over HTTP: see `daemon.rs`;
//!                 BLOCKD_DAEMON_TOKEN is the bearer token every request needs)
//! blockd request --daemon <host:port|socket> --path /v1/… [--body <json>] [--method …]
//! blockd disconnect --nbd /dev/nbd0   (detach a device whose blockd died)
//! blockd control --socket <socket> --request '{"op":"sync"}'
//! ```
//!
//! Stores: `local:<dir>` or `s3://<bucket>/<prefix>`. Every command also takes
//! `--heads <url>` and `--journal <url>`: heads and journal entries from a
//! coordinator over HTTP instead of the store.

use anyhow::{Context, Result, bail};
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::Arc;
use volume::Hash;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let flags = parse_flags(args)?;
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())
    };
    // A call's stdout and stderr are its command's: blockd logs elsewhere.
    match flags.get("log") {
        Some(log) => {
            let file = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
            tracing_subscriber::fmt()
                .with_env_filter(filter())
                .with_writer(std::sync::Mutex::new(file))
                .with_ansi(false)
                .init();
        }
        None => tracing_subscriber::fmt()
            .with_env_filter(filter())
            .with_writer(std::io::stderr)
            .init(),
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let store = || {
        blockd::store::open(
            flags.required("store")?,
            flags.get("heads"),
            flags.get("journal"),
        )
    };
    match command.as_str() {
        "control" => {
            use std::io::{BufRead, Write};
            let mut stream = std::os::unix::net::UnixStream::connect(flags.required("socket")?)?;
            stream.write_all(format!("{}\n", flags.required("request")?).as_bytes())?;
            let mut reply = String::new();
            std::io::BufReader::new(stream).read_line(&mut reply)?;
            print!("{reply}");
            if !reply.contains("\"ok\":true") {
                std::process::exit(1);
            }
        }
        "create" => {
            let volume = store()?;
            let size: u64 = flags.required("size")?.parse().context("--size")?;
            println!(
                "{}",
                runtime.block_on(volume.create(flags.required("head")?, size))?
            );
        }
        "import" => {
            let volume = store()?;
            let path = flags.required("image")?;
            let file = std::fs::File::open(path).with_context(|| format!("opening {path}"))?;
            check_ext4_block_size(&file, path)?;
            let size = file.metadata()?.len();
            let reader = std::io::BufReader::with_capacity(4 << 20, file);
            println!(
                "{}",
                runtime.block_on(volume.import(flags.required("head")?, size, reader))?
            );
        }
        "fork" => {
            let volume = store()?;
            println!(
                "{}",
                runtime.block_on(volume.fork(flags.required("from")?, flags.required("to")?))?
            );
        }
        "reset" => {
            let volume = store()?;
            let to = Hash::from_hex(flags.required("to")?).context("--to is not a snapshot id")?;
            runtime.block_on(volume.reset(flags.required("head")?, to))?;
        }
        "drop" => runtime.block_on(store()?.drop_head(flags.required("head")?))?,
        "gc" => {
            let options = volume::GcOptions {
                history: flags.get("history").map(str::parse).transpose()?,
                grace: std::time::Duration::from_secs(
                    flags
                        .get("grace-seconds")
                        .map(str::parse)
                        .transpose()?
                        .unwrap_or(3600),
                ),
                dry_run: flags.get("dry-run") == Some("true"),
            };
            let report = runtime.block_on(store()?.gc(&options))?;
            println!("{}", serde_json::to_string(&report)?);
        }
        "export" => {
            use std::os::unix::fs::FileExt;
            let volume = store()?;
            let head = runtime.block_on(volume.head(flags.required("head")?))?;
            let manifest = runtime.block_on(volume.manifest(&head))?;
            let image = std::fs::File::create(flags.required("image")?)?;
            image.set_len(manifest.size)?;
            for extent in 0..manifest.extents() {
                if let Some(bytes) = runtime.block_on(volume.read_extent(&head, extent))? {
                    image.write_all_at(&bytes, extent * volume::EXTENT_SIZE)?;
                }
            }
            image.sync_all()?;
            println!("{head}");
        }
        "heads" => {
            for (head, id) in runtime.block_on(store()?.heads())? {
                println!("{head} {id}");
            }
        }
        "history" => {
            let volume = store()?;
            let limit = flags
                .get("limit")
                .map(str::parse)
                .transpose()?
                .unwrap_or(20);
            let head = runtime.block_on(volume.head(flags.required("head")?))?;
            for id in runtime.block_on(volume.history(&head, limit))? {
                println!("{id}");
            }
        }
        "attach" => attach(&flags, store()?, &runtime)?,
        #[cfg(target_os = "linux")]
        "exec" => {
            let cache = std::path::Path::new(flags.required("cache")?);
            let device = std::sync::Arc::new(blockd::Device::open(
                std::sync::Arc::new(store()?),
                flags.required("head")?,
                cache,
                runtime.handle().clone(),
            )?);
            let mode = mode(&flags)?;
            tracing::info!("exec in {mode:?} mode");
            let code = blockd::exec::exec(
                &device,
                mode,
                cache,
                std::path::Path::new(flags.required("dir")?),
                flags.required("command")?,
            )?;
            let snapshot = device.close()?;
            eprintln!(
                "{}",
                serde_json::json!({ "mode": mode, "exitCode": code, "snapshot": snapshot })
            );
            std::process::exit(code);
        }
        #[cfg(target_os = "linux")]
        "mount" => serve_mount(&flags, store()?, &runtime)?,
        #[cfg(target_os = "linux")]
        "call" => call(&flags, store()?, &runtime)?,
        #[cfg(target_os = "linux")]
        "diff" => diff(&flags, store()?, &runtime)?,
        #[cfg(target_os = "linux")]
        "apply" => {
            let mut file = std::fs::File::open(flags.required("patch-file")?)?;
            let summary = blockd::patch::apply(
                &mut std::io::BufReader::new(&mut file),
                std::path::Path::new(flags.required("dir")?),
            )?;
            println!("{}", serde_json::to_string(&summary)?);
        }
        #[cfg(target_os = "linux")]
        "daemon" => daemon(&flags, &runtime)?,
        "request" => {
            let (status, reply) = blockd::http::request(
                flags.required("daemon")?,
                std::env::var("BLOCKD_DAEMON_TOKEN").ok().as_deref(),
                flags.get("method").unwrap_or(if flags.get("body").is_some() { "POST" } else { "GET" }),
                flags.required("path")?,
                flags.get("body"),
            )?;
            println!("{reply}");
            if status != 200 {
                std::process::exit(1);
            }
        }
        #[cfg(target_os = "linux")]
        "disconnect" => {
            blockd::nbd::force_disconnect(std::path::Path::new(flags.required("nbd")?))?
        }
        _ => bail!(
            "usage: blockd <create|import|fork|reset|drop|export|gc|heads|history|attach|mount|exec|call|diff|apply|daemon|request|control|disconnect> …"
        ),
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn attach(flags: &Flags, volume: volume::Volume, runtime: &tokio::runtime::Runtime) -> Result<()> {
    use std::path::{Path, PathBuf};
    let head = flags.required("head")?;
    let cache = Path::new(flags.required("cache")?);
    let device = Arc::new(blockd::Device::open(
        Arc::new(volume),
        head,
        cache,
        runtime.handle().clone(),
    )?);
    let every: u64 = flags
        .get("flush-every")
        .map(str::parse)
        .transpose()?
        .unwrap_or(5);
    let flusher = (every > 0).then(|| device.start_flusher(std::time::Duration::from_secs(every)));
    if flags.get("prefetch") == Some("true") {
        let device = device.clone();
        std::thread::spawn(move || match device.prefetch(16) {
            Ok(n) => tracing::info!("prefetched {n} extents"),
            Err(e) => tracing::warn!("prefetch stopped: {e:#}"),
        });
    }
    let control = flags.get("control").map(PathBuf::from);
    let serve_control = |on_detach: Box<dyn FnMut() -> Result<()> + Send>| {
        if let Some(socket) = control.clone() {
            let device = device.clone();
            std::thread::spawn(move || {
                if let Err(e) =
                    blockd::control::serve(&socket, device, blockd::control::DetachOnly(on_detach))
                {
                    tracing::error!("control socket: {e:#}");
                }
            });
        }
    };

    match (flags.get("nbd"), flags.get("ublk")) {
        #[cfg(feature = "ublk")]
        (None, Some(_)) => {
            let id: i32 = flags.required("ublk")?.parse()?;
            let ublk = blockd::ublk::Ublk::create(id, 1)?;
            let killer = ublk.killer();
            serve_control(Box::new(move || {
                killer.kill();
                Ok(())
            }));
            let size = device.size();
            let head_name = head.to_string();
            ublk.serve(device.clone(), move |path| {
                tracing::info!("attached {head_name} ({size} bytes) at {path}");
                println!("{path}");
            })?;
        }
        (Some(nbd), None) => {
            let attachment = blockd::nbd::attach(Path::new(nbd), device.clone())?;
            tracing::info!("attached {head} ({} bytes) at {nbd}", device.size());
            let disconnector = attachment.disconnector()?;
            serve_control(Box::new(move || {
                disconnector.disconnect();
                Ok(())
            }));
            attachment.wait()?;
        }
        _ => {
            bail!(
                "attach needs exactly one of --nbd <device> or --ublk <id> (to mount, use blockd mount)"
            )
        }
    }
    drop(flusher);
    let snapshot = device.close()?;
    tracing::info!("detached {head} at snapshot {snapshot}");
    println!("{snapshot}");
    Ok(())
}

/// `--mode`, or the best this host allows.
#[cfg(target_os = "linux")]
fn mode(flags: &Flags) -> Result<blockd::mount::Mode> {
    match flags.get("mode").unwrap_or("auto") {
        "auto" => blockd::mount::Mode::detect(),
        other => other.parse(),
    }
}

/// Mounts a head and serves it until a detach on the control socket.
#[cfg(target_os = "linux")]
fn serve_mount(
    flags: &Flags,
    volume: volume::Volume,
    runtime: &tokio::runtime::Runtime,
) -> Result<()> {
    use std::path::Path;
    let socket = Path::new(flags.required("control")?);
    let (head, ready) = blockd::head::Head::mount(
        Arc::new(volume),
        flags.required("head")?,
        blockd::head::HeadOptions {
            mode: mode(flags)?,
            cache: Path::new(flags.required("cache")?),
            dir: Path::new(flags.required("dir")?),
            flush_every: flags
                .get("flush-every")
                .map(str::parse)
                .transpose()?
                .unwrap_or(5),
            prefetch: flags.get("prefetch") == Some("true"),
        },
        runtime.handle().clone(),
    )?;
    println!("{}", serde_json::to_string(&ready)?);
    let device = head.device().clone();
    let mut ops = HeadOps(head);
    blockd::control::serve(socket, device.clone(), &mut ops)?;
    let snapshot = device.close()?;
    tracing::info!("detached {} at snapshot {snapshot}", ops.0.name());
    Ok(())
}

/// A mounted head's control operations: checkpoints and patches.
#[cfg(target_os = "linux")]
struct HeadOps(blockd::head::Head);

#[cfg(target_os = "linux")]
impl blockd::control::MountOps for &mut HeadOps {
    fn detach(&mut self) -> Result<serde_json::Value> {
        Ok(serde_json::json!({ "paths": self.0.unmount()? }))
    }

    fn checkpoint(&mut self) -> Result<serde_json::Value> {
        Ok(serde_json::json!({ "paths": self.0.checkpoint()? }))
    }

    fn apply(&mut self, patches: &[String]) -> Result<serde_json::Value> {
        self.0.apply(patches)
    }
}

/// `blockd call`: a command on an ephemeral fork, and its patch. With
/// `--keep true`, a command that leaves processes running keeps the fork
/// mounted for them, and blockd serves `--control` until a detach:
///
/// ```text
/// {"op":"commit","patch":"<key>","full":false} → what changed since the last commit
/// {"op":"status"}                              → the processes still running
/// {"op":"detach","patch":"<key>"}              → stop them, a last commit, unmount, exit
/// ```
#[cfg(target_os = "linux")]
fn call(flags: &Flags, volume: volume::Volume, runtime: &tokio::runtime::Runtime) -> Result<()> {
    use std::path::Path;
    let snapshot =
        Hash::from_hex(flags.required("snapshot")?).context("--snapshot is not a snapshot id")?;
    let volume = Arc::new(volume);
    let env: Vec<(String, String)> = match flags.get("env") {
        Some(json) => serde_json::from_str::<HashMap<String, String>>(json)
            .context("--env is a JSON object of strings")?
            .into_iter()
            .collect(),
        None => Vec::new(),
    };
    let run = blockd::call::Run {
        command: flags.required("command")?.to_string(),
        cwd: flags.get("cwd").map(Into::into),
        env,
        timeout: flags
            .get("timeout-ms")
            .map(str::parse::<u64>)
            .transpose()?
            .map(std::time::Duration::from_millis),
        ..Default::default()
    };
    let (report, kept) = blockd::call::call(
        &volume,
        snapshot,
        blockd::call::Spec {
            mode: mode(flags)?,
            cache: Path::new(flags.required("cache")?),
            dir: Path::new(flags.required("dir")?),
            work: Path::new(flags.required("work")?),
            run,
            patch: flags.get("patch").map(str::to_string),
            keep: flags.get("keep") == Some("true"),
        },
        runtime.handle(),
    )?;
    let value = serde_json::to_value(&report)?;
    match flags.get("result") {
        Some(path) => {
            // Written whole, then renamed: a reader never sees half of it.
            let tmp = format!("{path}.tmp");
            std::fs::write(&tmp, format!("{value}\n"))?;
            std::fs::rename(&tmp, path)?;
        }
        None => eprintln!("{value}"),
    }
    if let Some(kept) = kept {
        serve_host(kept, Path::new(flags.required("control")?), &volume, runtime)?;
    }
    Ok(())
}

/// Serves a kept call's control socket until a detach (see [`call`]).
#[cfg(target_os = "linux")]
fn serve_host(
    mut kept: blockd::call::Kept,
    socket: &std::path::Path,
    volume: &volume::Volume,
    runtime: &tokio::runtime::Runtime,
) -> Result<()> {
    use std::io::{BufRead, BufReader, Write};
    #[derive(serde::Deserialize)]
    #[serde(tag = "op", rename_all = "lowercase")]
    enum Request {
        Commit {
            patch: String,
            #[serde(default)]
            full: bool,
        },
        Status,
        Detach {
            patch: Option<String>,
        },
    }
    let _ = std::fs::remove_file(socket);
    let listener = std::os::unix::net::UnixListener::bind(socket)?;
    for stream in listener.incoming() {
        let stream = stream?;
        let mut writer = stream.try_clone()?;
        for line in BufReader::new(stream).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Request>(&line) {
                Err(e) => serde_json::json!({ "ok": false, "error": format!("bad request: {e}") }),
                Ok(Request::Status) => {
                    serde_json::json!({ "ok": true, "survivors": kept.call.survivors() })
                }
                Ok(Request::Commit { patch, full }) => {
                    let mut timings = blockd::timings::Timings::new();
                    match blockd::call::commit_to_store(
                        &mut kept.call,
                        Some(&patch),
                        volume,
                        runtime.handle(),
                        full,
                        &mut timings,
                    ) {
                        Ok((summary, key)) => serde_json::json!({
                            "ok": true, "patch": key, "summary": summary,
                            "survivors": kept.call.survivors(), "timings": timings,
                        }),
                        Err(e) => serde_json::json!({ "ok": false, "error": format!("{e:#}") }),
                    }
                }
                Ok(Request::Detach { patch }) => {
                    let reply = match kept.detach(patch.as_deref(), volume, runtime.handle()) {
                        Ok((summary, key, stopped, timings)) => serde_json::json!({
                            "ok": true, "patch": key, "summary": summary,
                            "survivors": stopped, "timings": timings,
                        }),
                        Err(e) => serde_json::json!({ "ok": false, "error": format!("{e:#}") }),
                    };
                    writer.write_all(format!("{reply}\n").as_bytes())?;
                    let _ = std::fs::remove_file(socket);
                    return Ok(());
                }
            };
            writer.write_all(format!("{reply}\n").as_bytes())?;
        }
    }
    Ok(())
}

/// `blockd diff`: a patch from one snapshot to another.
#[cfg(target_os = "linux")]
fn diff(flags: &Flags, volume: volume::Volume, runtime: &tokio::runtime::Runtime) -> Result<()> {
    use std::path::Path;
    let from = Hash::from_hex(flags.required("from")?).context("--from is not a snapshot id")?;
    let to = Hash::from_hex(flags.required("to")?).context("--to is not a snapshot id")?;
    let work = Path::new(flags.required("work")?);
    let made = blockd::call::diff(
        &Arc::new(volume),
        from,
        to,
        mode(flags)?,
        (
            Path::new(flags.required("cache")?),
            Path::new(flags.required("cache-to")?),
        ),
        work,
        flags.get("patch"),
        flags.get("patch-file").map(Path::new),
        runtime.handle(),
    )?;
    println!("{made}");
    Ok(())
}

/// `blockd daemon`: every head, call and cache on this machine, over HTTP.
#[cfg(target_os = "linux")]
fn daemon(flags: &Flags, runtime: &tokio::runtime::Runtime) -> Result<()> {
    use std::path::Path;
    let daemon = blockd::daemon::Daemon::new(
        blockd::daemon::Config {
            token: std::env::var("BLOCKD_DAEMON_TOKEN").ok().filter(|t| !t.is_empty()),
            state: flags.get("state").unwrap_or("/var/cache/blockd").into(),
            run: flags.get("run").unwrap_or("/run/blockd").into(),
        },
        runtime.handle().clone(),
    )?;
    blockd::daemon::serve(
        daemon,
        flags.get("listen"),
        flags.get("socket").map(Path::new),
        flags.get("pidfile").map(Path::new),
    )
}

#[cfg(not(target_os = "linux"))]
fn attach(_: &Flags, _: volume::Volume, _: &tokio::runtime::Runtime) -> Result<()> {
    bail!("attach needs Linux (NBD)")
}

/// Volumes are served with 4 KiB sectors, so an ext4 image must use 4 KiB
/// blocks (`mkfs.ext4 -b 4096`; small filesystems default to 1 KiB).
fn check_ext4_block_size(file: &std::fs::File, path: &str) -> Result<()> {
    use std::os::unix::fs::FileExt;
    let mut superblock = [0u8; 64];
    if file.read_exact_at(&mut superblock, 1024).is_err() {
        return Ok(()); // too small to be ext4: not ours to judge
    }
    let magic = u16::from_le_bytes([superblock[56], superblock[57]]);
    if magic != 0xEF53 {
        return Ok(());
    }
    let log = u32::from_le_bytes(superblock[24..28].try_into().unwrap());
    let block = 1024u64 << log;
    if block != volume::BLOCK_SIZE {
        bail!("{path} is ext4 with {block}-byte blocks; volumes need 4096 (mkfs.ext4 -b 4096)");
    }
    Ok(())
}

struct Flags(HashMap<String, String>);

impl Flags {
    fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    fn required(&self, name: &str) -> Result<&str> {
        self.get(name).with_context(|| format!("missing --{name}"))
    }
}

fn parse_flags(args: impl Iterator<Item = String>) -> Result<Flags> {
    let mut flags = HashMap::new();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        let Some(name) = arg.strip_prefix("--") else {
            bail!("unexpected argument {arg:?}")
        };
        let value = args
            .next()
            .with_context(|| format!("--{name} needs a value"))?;
        flags.insert(name.to_string(), value);
    }
    Ok(Flags(flags))
}
