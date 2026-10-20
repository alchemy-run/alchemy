//! Kernel attach over NBD: blockd configures `/dev/nbdN` itself with ioctls
//! and serves the kernel's requests on one end of a socket pair, so no
//! `nbd-client` and no handshake are needed.

use crate::Device;
use anyhow::{Context, Result, bail};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;

// linux/nbd.h
const NBD_SET_SOCK: libc::c_ulong = 0xab00;
const NBD_SET_BLKSIZE: libc::c_ulong = 0xab01;
const NBD_DO_IT: libc::c_ulong = 0xab03;
const NBD_CLEAR_SOCK: libc::c_ulong = 0xab04;
const NBD_CLEAR_QUE: libc::c_ulong = 0xab05;
const NBD_SET_SIZE_BLOCKS: libc::c_ulong = 0xab07;
const NBD_DISCONNECT: libc::c_ulong = 0xab08;
const NBD_SET_TIMEOUT: libc::c_ulong = 0xab09;
const NBD_SET_FLAGS: libc::c_ulong = 0xab0a;

const FLAG_HAS_FLAGS: u64 = 1 << 0;
const FLAG_SEND_FLUSH: u64 = 1 << 2;
const FLAG_SEND_FUA: u64 = 1 << 3;
const FLAG_SEND_TRIM: u64 = 1 << 5;

const REQUEST_MAGIC: u32 = 0x2560_9513;
const REPLY_MAGIC: u32 = 0x6744_6698;
const CMD_READ: u16 = 0;
const CMD_WRITE: u16 = 1;
const CMD_DISC: u16 = 2;
const CMD_FLUSH: u16 = 3;
const CMD_TRIM: u16 = 4;
const CMD_FLAG_FUA: u16 = 1 << 0;

const BLOCK: u64 = volume::BLOCK_SIZE;
const EIO: u32 = 5;
const EINVAL: u32 = 22;

/// An attached `/dev/nbdN`. Dropping it (or [`Attachment::detach`]) makes
/// the kernel disconnect.
pub struct Attachment {
    nbd: File,
    kernel: Option<std::thread::JoinHandle<Result<()>>>,
    server: Option<std::thread::JoinHandle<Result<()>>>,
}

impl Attachment {
    /// Disconnects the device and waits for both sides to finish.
    pub fn detach(mut self) -> Result<()> {
        self.disconnect();
        self.join()
    }

    /// Waits until the device is disconnected (by `detach` from another
    /// handle, `nbd-client -d`, or the kernel).
    pub fn wait(mut self) -> Result<()> {
        self.join()
    }

    pub fn disconnector(&self) -> Result<Disconnector> {
        Ok(Disconnector {
            nbd: self.nbd.try_clone()?,
        })
    }

    fn disconnect(&self) {
        unsafe { libc::ioctl(self.nbd.as_raw_fd(), NBD_DISCONNECT as _) };
    }

    fn join(&mut self) -> Result<()> {
        let kernel = self.kernel.take().map(|t| t.join());
        let server = self.server.take().map(|t| t.join());
        for joined in [kernel, server].into_iter().flatten() {
            joined.map_err(|_| anyhow::anyhow!("an nbd thread panicked"))??;
        }
        Ok(())
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        if self.kernel.is_some() {
            self.disconnect();
            let _ = self.join();
        }
    }
}

/// Disconnects an attachment from another thread (the control socket).
pub struct Disconnector {
    nbd: File,
}

impl Disconnector {
    pub fn disconnect(&self) {
        unsafe { libc::ioctl(self.nbd.as_raw_fd(), NBD_DISCONNECT as _) };
    }
}

/// Attaches `device` to the NBD device at `path` (e.g. `/dev/nbd0`).
pub fn attach(path: &Path, device: Arc<Device>) -> Result<Attachment> {
    let nbd = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| {
            format!(
                "opening {} (is the nbd module loaded, and is this privileged?)",
                path.display()
            )
        })?;
    let (kernel_end, server_end) = UnixStream::pair()?;
    let fd = nbd.as_raw_fd();
    let ioctl = |request: libc::c_ulong, arg: libc::c_ulong, what: &str| -> Result<()> {
        if unsafe { libc::ioctl(fd, request as _, arg) } < 0 {
            bail!("nbd {what}: {}", std::io::Error::last_os_error());
        }
        Ok(())
    };
    unsafe { libc::ioctl(fd, NBD_CLEAR_SOCK as _) };
    ioctl(NBD_SET_BLKSIZE, BLOCK as _, "set block size")?;
    ioctl(
        NBD_SET_SIZE_BLOCKS,
        (device.size() / BLOCK) as _,
        "set size",
    )?;
    ioctl(NBD_SET_TIMEOUT, 120, "set timeout")?;
    ioctl(
        NBD_SET_FLAGS,
        (FLAG_HAS_FLAGS | FLAG_SEND_FLUSH | FLAG_SEND_FUA | FLAG_SEND_TRIM) as _,
        "set flags",
    )?;
    ioctl(NBD_SET_SOCK, kernel_end.as_raw_fd() as _, "set socket")?;

    // NBD_DO_IT blocks until disconnect; the kernel owns its end meanwhile.
    let kernel_fd = nbd.try_clone()?;
    let kernel = std::thread::Builder::new()
        .name("nbd-kernel".into())
        .spawn(move || {
            let _keep = kernel_end;
            let result = unsafe { libc::ioctl(kernel_fd.as_raw_fd(), NBD_DO_IT as _) };
            unsafe {
                libc::ioctl(kernel_fd.as_raw_fd(), NBD_CLEAR_QUE as _);
                libc::ioctl(kernel_fd.as_raw_fd(), NBD_CLEAR_SOCK as _);
            }
            if result < 0 {
                let error = std::io::Error::last_os_error();
                // EPIPE/0 after a disconnect is the normal end.
                if !matches!(error.raw_os_error(), Some(libc::EPIPE) | Some(0)) {
                    tracing::warn!("nbd: NBD_DO_IT ended with {error}");
                }
            }
            Ok(())
        })?;
    let server = std::thread::Builder::new()
        .name("nbd-server".into())
        .spawn(move || serve(server_end, &device))?;
    Ok(Attachment {
        nbd,
        kernel: Some(kernel),
        server: Some(server),
    })
}

/// Answers the kernel's requests until it disconnects.
fn serve(mut socket: UnixStream, device: &Device) -> Result<()> {
    let mut header = [0u8; 28];
    let mut reply = Vec::with_capacity(16 + 128 * 1024);
    loop {
        match socket.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        let magic = u32::from_be_bytes(header[0..4].try_into().unwrap());
        if magic != REQUEST_MAGIC {
            bail!("nbd: bad request magic {magic:#x}");
        }
        let flags = u16::from_be_bytes(header[4..6].try_into().unwrap());
        let command = u16::from_be_bytes(header[6..8].try_into().unwrap());
        let handle: [u8; 8] = header[8..16].try_into().unwrap();
        let offset = u64::from_be_bytes(header[16..24].try_into().unwrap());
        let len = u32::from_be_bytes(header[24..28].try_into().unwrap());

        reply.clear();
        let error = match command {
            CMD_READ => match device.read(offset, len) {
                Ok(bytes) => {
                    write_reply_header(&mut reply, 0, &handle);
                    reply.extend_from_slice(&bytes);
                    None
                }
                Err(e) => Some(fail("read", offset, len, e)),
            },
            CMD_WRITE => {
                let mut data = vec![0; len as usize];
                socket.read_exact(&mut data)?;
                let written = device.write(offset, &data);
                let durable = if flags & CMD_FLAG_FUA != 0 {
                    device.flush().map(|_| ())
                } else {
                    Ok(())
                };
                match written.and(durable) {
                    Ok(()) => None,
                    Err(e) => Some(fail("write", offset, len, e)),
                }
            }
            CMD_FLUSH => device.flush().err().map(|e| fail("flush", offset, len, e)),
            CMD_TRIM => device
                .zero(offset, len as u64)
                .err()
                .map(|e| fail("trim", offset, len, e)),
            CMD_DISC => {
                // The kernel expects no reply; commit what's left.
                device.flush()?;
                return Ok(());
            }
            other => {
                tracing::warn!("nbd: unsupported command {other}");
                Some(EINVAL)
            }
        };
        if reply.is_empty() {
            write_reply_header(&mut reply, error.unwrap_or(0), &handle);
        }
        socket.write_all(&reply)?;
    }
}

fn write_reply_header(reply: &mut Vec<u8>, error: u32, handle: &[u8; 8]) {
    reply.extend_from_slice(&REPLY_MAGIC.to_be_bytes());
    reply.extend_from_slice(&error.to_be_bytes());
    reply.extend_from_slice(handle);
}

fn fail(what: &str, offset: u64, len: u32, error: anyhow::Error) -> u32 {
    tracing::error!("nbd {what} at {offset}+{len}: {error:#}");
    EIO
}
