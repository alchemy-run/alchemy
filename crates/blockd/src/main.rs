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
//! blockd attach  --store <spec> --head <name> --cache <file> (--nbd /dev/nbd0 | --ublk <id> | --fuse <mountpoint>)
//!                [--control <socket>] [--flush-every <seconds>] [--prefetch true]
//! blockd run     --store <spec> --head <name> --cache <file> --dir <dir> --command <sh> [--keep true]
//!                (copy mode: extract, run, write back; for hosts that can't mount)
//! blockd exec    --store <spec> --head <name> --cache <file> --dir <dir> --command <sh> [--mode auto|ublk|nbd|fuse|copy]
//!                (attach in the best mode the host allows, run, detach; exits with the command's code)
//! blockd disconnect --nbd /dev/nbd0   (detach a device whose blockd died)
//! blockd control --socket <socket> --request '{"op":"flush"}'
//! ```
//!
//! Stores: `local:<dir>` or `s3://<bucket>/<prefix>`.

use anyhow::{Context, Result, bail};
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::Arc;
use volume::Hash;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let flags = parse_flags(args)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let store = || blockd::store::open(flags.required("store")?);
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
            let mode = match flags.get("mode").unwrap_or("auto") {
                "auto" => blockd::exec::Mode::detect(),
                other => other.parse()?,
            };
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
        "run" => {
            let device = blockd::Device::open(
                std::sync::Arc::new(store()?),
                flags.required("head")?,
                std::path::Path::new(flags.required("cache")?),
                runtime.handle().clone(),
            )?;
            let options = blockd::copy::RunOptions {
                dir: flags.required("dir")?.into(),
                command: flags.required("command")?.to_string(),
                keep: flags.get("keep") == Some("true"),
            };
            let outcome = blockd::copy::run(&device, &options)?;
            let snapshot = device.close()?;
            tracing::info!("ran in copy mode: {outcome:?}, head at {snapshot}");
            std::process::exit(outcome.exit_code);
        }
        #[cfg(target_os = "linux")]
        "disconnect" => {
            blockd::nbd::force_disconnect(std::path::Path::new(flags.required("nbd")?))?
        }
        _ => bail!(
            "usage: blockd <create|import|fork|reset|drop|export|gc|heads|history|attach|exec|run|control|disconnect> …"
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
    let serve_control = |on_detach: Box<dyn Fn() + Send>| {
        if let Some(socket) = control.clone() {
            let device = device.clone();
            std::thread::spawn(move || {
                if let Err(e) = blockd::control::serve(&socket, device, on_detach) {
                    tracing::error!("control socket: {e:#}");
                }
            });
        }
    };

    match (flags.get("nbd"), flags.get("fuse")) {
        #[cfg(feature = "ublk")]
        (None, None) if flags.get("ublk").is_some() => {
            let id: i32 = flags.required("ublk")?.parse()?;
            let ublk = blockd::ublk::Ublk::create(id, 1)?;
            let killer = ublk.killer();
            serve_control(Box::new(move || killer.kill()));
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
            serve_control(Box::new(move || disconnector.disconnect()));
            attachment.wait()?;
        }
        #[cfg(feature = "fuse")]
        (None, Some(mountpoint)) => {
            let disk_dir = cache.with_extension("disk");
            let mounted = blockd::fuse::mount(device.clone(), &disk_dir, Path::new(mountpoint))?;
            tracing::info!(
                "mounted {head} ({} bytes) at {mountpoint} over FUSE",
                device.size()
            );
            let target = PathBuf::from(mountpoint);
            serve_control(Box::new(move || {
                if let Err(e) = blockd::fuse::unmount(&target) {
                    tracing::error!("{e:#}");
                }
            }));
            mounted.wait()?;
        }
        _ => {
            bail!("attach needs exactly one of --nbd <device>, --ublk <id> or --fuse <mountpoint>")
        }
    }
    drop(flusher);
    let snapshot = device.close()?;
    tracing::info!("detached {head} at snapshot {snapshot}");
    println!("{snapshot}");
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
