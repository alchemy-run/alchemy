//! ```text
//! blockd create  --store <spec> --head <name> --size <bytes>
//! blockd import  --store <spec> --head <name> --image <file>
//! blockd fork    --store <spec> --from <head> --to <head>
//! blockd reset   --store <spec> --head <name> --to <snapshot>
//! blockd drop    --store <spec> --head <name>
//! blockd heads   --store <spec>
//! blockd history --store <spec> --head <name> [--limit <n>]
//! blockd attach  --store <spec> --head <name> --nbd /dev/nbd0 --cache <file> [--control <socket>] [--flush-every <seconds>]
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
        "disconnect" => {
            blockd::nbd::force_disconnect(std::path::Path::new(flags.required("nbd")?))?
        }
        _ => bail!(
            "usage: blockd <create|import|fork|reset|drop|heads|history|attach|control|disconnect> …"
        ),
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn attach(flags: &Flags, volume: volume::Volume, runtime: &tokio::runtime::Runtime) -> Result<()> {
    let head = flags.required("head")?;
    let cache = std::path::Path::new(flags.required("cache")?);
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
    let attachment =
        blockd::nbd::attach(std::path::Path::new(flags.required("nbd")?), device.clone())?;
    tracing::info!(
        "attached {head} ({} bytes) at {}",
        device.size(),
        flags.required("nbd")?
    );
    if let Some(socket) = flags.get("control") {
        let disconnector = attachment.disconnector()?;
        let socket = std::path::PathBuf::from(socket);
        let control_device = device.clone();
        std::thread::spawn(move || {
            if let Err(e) =
                blockd::control::serve(&socket, control_device, || disconnector.disconnect())
            {
                tracing::error!("control socket: {e:#}");
            }
        });
    }
    attachment.wait()?;
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
