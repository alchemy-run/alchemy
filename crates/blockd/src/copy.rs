//! Copy attach: for hosts that can't mount anything (no block devices, no
//! FUSE, no mount rights). The volume's files are copied into a directory,
//! the command runs there, and the directory is written back as ext4 blocks:
//!
//! 1. materialize the cache file into a complete image of the head;
//! 2. extract its files with `debugfs rdump` (e2fsprogs, no privileges);
//! 3. run the command in that directory;
//! 4. rebuild an image from the directory with `mkfs.ext4 -d`, keeping the
//!    filesystem's UUID and hash seed so unchanged parts rebuild identically;
//! 5. write only the blocks that differ into the device, and commit.
//!
//! It's the slowest mode (a copy before and a rebuild after every command),
//! and it writes the same volumes every other mode reads.

use crate::Device;
use anyhow::{Context, Result, bail};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use volume::BLOCK_SIZE;

pub struct RunOptions {
    /// Where the files are extracted and the command runs.
    pub dir: PathBuf,
    /// Run with `sh -c`.
    pub command: String,
    /// Leave the directory behind (for debugging).
    pub keep: bool,
}

/// What a run did.
#[derive(Debug, serde::Serialize)]
pub struct RunOutcome {
    pub exit_code: i32,
    pub blocks_written: u64,
}

pub fn run(device: &Device, options: &RunOptions) -> Result<RunOutcome> {
    device.materialize()?;
    let image = device.cache_path();
    let params = Params::read(image)?;

    if options.dir.exists() {
        std::fs::remove_dir_all(&options.dir)?;
    }
    std::fs::create_dir_all(&options.dir)?;
    let request = format!("rdump / {}", options.dir.display());
    tool(
        "debugfs",
        Command::new("debugfs").args(["-R", &request]).arg(image),
    )?;
    // rdump writes the root as a directory named after it inside the target.
    let root = find_root(&options.dir)?;

    let status = Command::new("sh")
        .args(["-c", &options.command])
        .current_dir(&root)
        .status()
        .context("running the command")?;
    let exit_code = status.code().unwrap_or(128);

    let rebuilt = image.with_extension("rebuild");
    let _ = std::fs::remove_file(&rebuilt);
    let mut mkfs = Command::new("mkfs.ext4");
    mkfs.args([
        "-q",
        "-F",
        "-t",
        "ext4",
        "-b",
        &BLOCK_SIZE.to_string(),
        "-d",
    ])
    .arg(&root)
    .args([
        "-U",
        &params.uuid,
        "-E",
        &format!("hash_seed={}", params.hash_seed),
    ]);
    if let Some(label) = &params.label {
        mkfs.args(["-L", label]);
    }
    mkfs.arg(&rebuilt).arg(format!("{}k", device.size() / 1024));
    mkfs.env("E2FSPROGS_FAKE_TIME", params.created.to_string());
    tool("mkfs.ext4", &mut mkfs)?;

    let blocks_written = write_differences(device, image, &rebuilt)?;
    std::fs::remove_file(&rebuilt)?;
    if !options.keep {
        std::fs::remove_dir_all(&options.dir)?;
    }
    Ok(RunOutcome {
        exit_code,
        blocks_written,
    })
}

/// Writes every block of `rebuilt` that differs from the current image.
fn write_differences(device: &Device, current: &Path, rebuilt: &Path) -> Result<u64> {
    let (current, rebuilt) = (std::fs::File::open(current)?, std::fs::File::open(rebuilt)?);
    const CHUNK: u64 = 4 * 1024 * 1024;
    let (mut a, mut b) = (vec![0u8; CHUNK as usize], vec![0u8; CHUNK as usize]);
    let mut written = 0;
    let mut offset = 0;
    while offset < device.size() {
        let n = CHUNK.min(device.size() - offset) as usize;
        current.read_exact_at(&mut a[..n], offset)?;
        rebuilt.read_exact_at(&mut b[..n], offset)?;
        if a[..n] != b[..n] {
            for block in (0..n).step_by(BLOCK_SIZE as usize) {
                let end = block + BLOCK_SIZE as usize;
                if a[block..end] != b[block..end] {
                    device.write(offset + block as u64, &b[block..end])?;
                    written += 1;
                }
            }
        }
        offset += n as u64;
    }
    Ok(written)
}

/// The rdump target: debugfs dumps `/` as a nested directory.
fn find_root(dir: &Path) -> Result<PathBuf> {
    let entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    match entries.as_slice() {
        [only] if only.file_type()?.is_dir() && !dir.join("lost+found").exists() => {
            let nested = only.path();
            if nested.join("lost+found").exists() || nested.file_name() == Some("".as_ref()) {
                return Ok(nested);
            }
            Ok(dir.to_path_buf())
        }
        _ => Ok(dir.to_path_buf()),
    }
}

/// Filesystem parameters kept across a rebuild.
struct Params {
    uuid: String,
    hash_seed: String,
    label: Option<String>,
    created: u64,
}

impl Params {
    fn read(image: &Path) -> Result<Self> {
        let output = Command::new("dumpe2fs")
            .arg("-h")
            .arg(image)
            .output()
            .context("running dumpe2fs")?;
        if !output.status.success() {
            bail!(
                "dumpe2fs failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let field = |name: &str| {
            text.lines().find_map(|line| {
                line.strip_prefix(name)
                    .map(|v| v.trim_start_matches(':').trim().to_string())
            })
        };
        let uuid = field("Filesystem UUID").context("no UUID in dumpe2fs")?;
        let hash_seed = field("Directory Hash Seed").context("no hash seed in dumpe2fs")?;
        let label = field("Filesystem volume name").filter(|l| l != "<none>" && !l.is_empty());
        let created = field("Filesystem created")
            .and_then(|date| {
                Command::new("date")
                    .args(["-d", &date, "+%s"])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            })
            .unwrap_or(1);
        Ok(Self {
            uuid,
            hash_seed,
            label,
            created,
        })
    }
}

fn tool(name: &str, command: &mut Command) -> Result<()> {
    let output = command
        .output()
        .with_context(|| format!("running {name} (install e2fsprogs)"))?;
    if !output.status.success() {
        bail!(
            "{name} failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}
