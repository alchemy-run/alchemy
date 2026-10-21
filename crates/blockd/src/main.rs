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
//!                [--cwd <dir>] [--env <json>] [--timeout-ms <n>] [--patch <key>] [--patch-file <file>]
//!                [--result <file>] [--mode …]
//!                (run a command on an ephemeral fork of a snapshot and make a patch of what it
//!                 changed: uploaded to the store as <key>, or written to <file>)
//! blockd diff    --store <spec> --from <id> --to <id> --cache <file> --cache-to <file> --work <dir>
//!                (--patch <key> | --patch-file <file>)   (a patch from one snapshot to another)
//! blockd apply   --dir <dir> --patch-file <file>     (apply a patch to a directory)
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
        "disconnect" => {
            blockd::nbd::force_disconnect(std::path::Path::new(flags.required("nbd")?))?
        }
        _ => bail!(
            "usage: blockd <create|import|fork|reset|drop|export|gc|heads|history|attach|mount|exec|call|diff|apply|control|disconnect> …"
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
    let head = flags.required("head")?;
    let cache = Path::new(flags.required("cache")?);
    let dir = Path::new(flags.required("dir")?);
    let socket = Path::new(flags.required("control")?);
    let volume = Arc::new(volume);
    let device = Arc::new(blockd::Device::open(
        volume.clone(),
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
    let mode = mode(flags)?;
    let mut mounted = blockd::mount::mount(&device, mode, cache, dir)?;
    let fs = mounted.fs();
    let top = cache.with_extension("top");
    if fs == blockd::fs::Fs::Btrfs {
        mounted.mount_top(&top, false)?;
    }
    let tracker = blockd::track::Tracker::start(
        fs,
        dir,
        (fs == blockd::fs::Fs::Btrfs).then_some(top.as_path()),
    );
    let status = device.status();
    println!(
        "{}",
        serde_json::json!({
            "mounted": dir, "mode": mode, "head": head, "fs": fs,
            "snapshot": status.base, "epoch": status.epoch,
        })
    );
    tracing::info!("mounted {head} at {} in {mode:?} mode ({fs:?})", dir.display());
    blockd::control::serve(
        socket,
        device.clone(),
        HeadOps {
            mounted: Some(mounted),
            tracker,
            volume,
            dir: dir.to_path_buf(),
            runtime: runtime.handle().clone(),
        },
    )?;
    drop(flusher);
    let snapshot = device.close()?;
    tracing::info!("detached {head} at snapshot {snapshot}");
    Ok(())
}

/// A mounted head's control operations: checkpoints and patches.
#[cfg(target_os = "linux")]
struct HeadOps {
    mounted: Option<blockd::mount::Mount>,
    tracker: blockd::track::Tracker,
    volume: Arc<volume::Volume>,
    dir: std::path::PathBuf,
    runtime: tokio::runtime::Handle,
}

#[cfg(target_os = "linux")]
impl blockd::control::MountOps for HeadOps {
    fn detach(&mut self) -> Result<serde_json::Value> {
        let paths = self.tracker.checkpoint().unwrap_or_else(|e| {
            tracing::warn!("the last checkpoint failed: {e:#}");
            None
        });
        self.tracker.stop();
        if let Some(mounted) = self.mounted.take() {
            mounted.unmount()?;
        }
        Ok(serde_json::json!({ "paths": paths }))
    }

    fn checkpoint(&mut self) -> Result<serde_json::Value> {
        Ok(serde_json::json!({ "paths": self.tracker.checkpoint()? }))
    }

    fn apply(&mut self, patches: &[String]) -> Result<serde_json::Value> {
        let paths = self.tracker.checkpoint()?;
        let mut applied = Vec::new();
        for key in patches {
            let bytes = self
                .runtime
                .block_on(self.volume.blobs().get(key))
                .with_context(|| format!("reading patch {key}"))?;
            let summary = blockd::patch::apply(&mut bytes.as_slice(), &self.dir)
                .with_context(|| format!("applying patch {key}"))?;
            applied.push(summary);
        }
        blockd::mount::sync(&self.dir);
        self.tracker.reset()?;
        Ok(serde_json::json!({ "paths": paths, "applied": applied }))
    }
}

/// `blockd call`: a command on an ephemeral fork, and its patch.
#[cfg(target_os = "linux")]
fn call(flags: &Flags, volume: volume::Volume, runtime: &tokio::runtime::Runtime) -> Result<()> {
    use std::path::Path;
    let snapshot =
        Hash::from_hex(flags.required("snapshot")?).context("--snapshot is not a snapshot id")?;
    let cache = Path::new(flags.required("cache")?);
    let dir = Path::new(flags.required("dir")?);
    let work = Path::new(flags.required("work")?);
    let volume = Arc::new(volume);
    let device = Arc::new(blockd::Device::open_snapshot(
        volume.clone(),
        snapshot,
        cache,
        runtime.handle().clone(),
    )?);
    let call = blockd::call::Call::mount(&device, mode(flags)?, cache, dir, work)?;
    let env: Vec<(String, String)> = match flags.get("env") {
        Some(json) => serde_json::from_str::<HashMap<String, String>>(json)
            .context("--env is a JSON object of strings")?
            .into_iter()
            .collect(),
        None => Vec::new(),
    };
    let timeout = flags
        .get("timeout-ms")
        .map(str::parse::<u64>)
        .transpose()?
        .map(std::time::Duration::from_millis);
    let ran = call.run(
        flags.required("command")?,
        flags.get("cwd").map(Path::new),
        &env,
        timeout,
    );
    let survivors = call.stop_survivors();
    let mut call = call;
    let made = (|| -> Result<(blockd::patch::Summary, Option<String>)> {
        let (code, _) = ran.as_ref().map_err(|e| anyhow::anyhow!("{e:#}"))?;
        let _ = code;
        let file_path = flags
            .get("patch-file")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| work.with_extension("patch"));
        let mut file = std::io::BufWriter::new(std::fs::File::create(&file_path)?);
        let summary = call.commit(Some(&mut file))?;
        drop(file);
        let mut key = None;
        if let Some(name) = flags.get("patch")
            && summary.operations > 0
        {
            let bytes = std::fs::read(&file_path)?;
            runtime.block_on(volume.blobs().put(name, bytes))?;
            key = Some(name.to_string());
        }
        if flags.get("patch-file").is_none() {
            let _ = std::fs::remove_file(&file_path);
        }
        Ok((summary, key))
    })();
    let fs = call.fs();
    let unmounted = call.unmount();
    device.close()?;
    let (code, timed_out) = ran?;
    let (summary, key) = made?;
    unmounted?;
    let result = serde_json::json!({
        "exitCode": code, "timedOut": timed_out, "fs": fs, "snapshot": snapshot,
        "patch": key, "summary": summary, "survivors": survivors,
    });
    match flags.get("result") {
        Some(path) => std::fs::write(path, format!("{result}\n"))?,
        None => eprintln!("{result}"),
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
    let volume = Arc::new(volume);
    let mode = mode(flags)?;
    let open = |id: Hash, cache: &str| -> Result<Arc<blockd::Device>> {
        Ok(Arc::new(blockd::Device::open_snapshot(
            volume.clone(),
            id,
            Path::new(cache),
            runtime.handle().clone(),
        )?))
    };
    let (cache_from, cache_to) = (flags.required("cache")?, flags.required("cache-to")?);
    let (a, b) = (open(from, cache_from)?, open(to, cache_to)?);
    let base = blockd::mount::mount_as(&a, mode, Path::new(cache_from), &work.join("from"), true)?;
    let current = blockd::mount::mount_as(&b, mode, Path::new(cache_to), &work.join("to"), true)?;
    let made = (|| -> Result<serde_json::Value> {
        let candidates = blockd::patch::walk_candidates(
            base.dir(),
            current.dir(),
            base.fs() == blockd::fs::Fs::Btrfs,
        )?;
        let file_path = flags
            .get("patch-file")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| work.with_extension("patch"));
        let mut file = std::io::BufWriter::new(std::fs::File::create(&file_path)?);
        let summary = blockd::patch::create(base.dir(), current.dir(), &candidates, Some(&mut file))?;
        drop(file);
        let mut key = None;
        if let Some(name) = flags.get("patch")
            && summary.operations > 0
        {
            runtime.block_on(volume.blobs().put(name, std::fs::read(&file_path)?))?;
            key = Some(name.to_string());
        }
        if flags.get("patch-file").is_none() {
            let _ = std::fs::remove_file(&file_path);
        }
        Ok(serde_json::json!({ "patch": key, "summary": summary }))
    })();
    let unmounted = base.unmount().and(current.unmount());
    a.close()?;
    b.close()?;
    let made = made?;
    unmounted?;
    println!("{made}");
    Ok(())
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
