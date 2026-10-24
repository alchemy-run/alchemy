//! Kernel attach over ublk (Linux 6.0+): the kernel's block requests arrive
//! through io_uring commands on `/dev/ublkcN`, and the device appears as
//! `/dev/ublkbN`. Faster than NBD (no socket protocol, no extra copies
//! through a stream), and the same [`Device`] underneath.

use crate::Device;
use anyhow::{Result, anyhow};
use libublk::ctrl::{UblkCtrl, UblkCtrlBuilder};
use libublk::io::{BufDescList, UblkDev, UblkIOCtx, UblkQueue};
use libublk::{BufDesc, UblkFlags, UblkIORes};
use std::rc::Rc;
use std::sync::Arc;

/// A ublk device being created or served.
pub struct Ublk {
    ctrl: Arc<UblkCtrl>,
}

/// Stops a served device from another thread (the control socket).
#[derive(Clone)]
pub struct Killer {
    ctrl: Arc<UblkCtrl>,
}

impl Killer {
    /// Stops the device. libublk's control ring is per thread, so this sets
    /// one up on the calling thread first.
    pub fn kill(&self) {
        let ring = libublk::ublk_init_ctrl_task_ring(|ring| {
            if ring.is_none() {
                *ring = Some(
                    io_uring::IoUring::<io_uring::squeue::Entry128>::builder()
                        .build(32)
                        .map_err(libublk::UblkError::IOError)?,
                );
            }
            Ok(())
        });
        if let Err(e) = ring {
            tracing::warn!("ublk: control ring: {e:?}");
        }
        if let Err(e) = self.ctrl.kill_dev() {
            tracing::warn!("ublk: kill_dev: {e:?}");
        }
    }
}

impl Ublk {
    /// Adds ublk device `id` (`/dev/ublkb<id>`), or the next free one if `id` is -1.
    pub fn create(id: i32, queues: u16) -> Result<Self> {
        let ctrl = UblkCtrlBuilder::default()
            .name("blockd")
            .id(id)
            .nr_queues(queues)
            .depth(64)
            .io_buf_bytes(512 * 1024)
            .dev_flags(UblkFlags::UBLK_DEV_F_ADD_DEV)
            .build()
            .map_err(|e| anyhow!("creating the ublk device (is ublk_drv loaded?): {e:?}"))?;
        Ok(Self {
            ctrl: Arc::new(ctrl),
        })
    }

    pub fn killer(&self) -> Killer {
        Killer {
            ctrl: self.ctrl.clone(),
        }
    }

    /// Serves `device` until the ublk device is killed. `ready` gets the block
    /// device's path once it exists.
    pub fn serve(
        &self,
        device: Arc<Device>,
        ready: impl FnOnce(String) + Send + Sync + 'static,
    ) -> Result<()> {
        let size = device.size();
        let init = |dev: &mut UblkDev| {
            dev.tgt.dev_size = size;
            dev.tgt.params = libublk::sys::ublk_params {
                types: libublk::sys::UBLK_PARAM_TYPE_BASIC,
                basic: libublk::sys::ublk_param_basic {
                    // A volatile cache: without it the kernel never sends FLUSH
                    // (sync/fsync) or FUA, and synced writes wait for the flusher.
                    attrs: libublk::sys::UBLK_ATTR_VOLATILE_CACHE | libublk::sys::UBLK_ATTR_FUA,
                    logical_bs_shift: 12,
                    physical_bs_shift: 12,
                    io_opt_shift: 12,
                    io_min_shift: 12,
                    max_sectors: dev.dev_info.max_io_buf_bytes >> 9,
                    dev_sectors: size >> 9,
                    ..Default::default()
                },
                ..Default::default()
            };
            Ok(())
        };
        let queue = move |qid: u16, dev: &UblkDev| serve_queue(qid, dev, &device);
        let started = move |ctrl: &UblkCtrl| ready(format!("/dev/ublkb{}", ctrl.dev_info().dev_id));
        self.ctrl
            .run_target(init, queue, started)
            .map_err(|e| anyhow!("ublk: {e:?}"))?;
        Ok(())
    }
}

impl Drop for Ublk {
    fn drop(&mut self) {
        let _ = self.ctrl.del_dev();
    }
}

fn serve_queue(qid: u16, dev: &UblkDev, device: &Arc<Device>) {
    let bufs = Rc::new(dev.alloc_queue_io_bufs());
    let handler_bufs = bufs.clone();
    let device = device.clone();
    let handler = move |q: &UblkQueue, tag: u16, _: &UblkIOCtx| {
        let buf = &handler_bufs[tag as usize];
        let iod = q.get_iod(tag);
        let op = iod.op_flags & 0xff;
        let offset = iod.start_sector << 9;
        let len = iod.nr_sectors << 9;
        // SAFETY: the kernel hands this tag's buffer to exactly one request at a time.
        let slice = unsafe {
            std::slice::from_raw_parts_mut(buf.as_slice().as_ptr() as *mut u8, len as usize)
        };
        let result = match op {
            libublk::sys::UBLK_IO_OP_READ => device
                .read(offset, len)
                .map(|bytes| slice.copy_from_slice(&bytes)),
            libublk::sys::UBLK_IO_OP_WRITE => device.write(offset, slice).and_then(|()| {
                if iod.op_flags & libublk::sys::UBLK_IO_F_FUA != 0 {
                    device.sync()
                } else {
                    Ok(())
                }
            }),
            libublk::sys::UBLK_IO_OP_FLUSH => device.sync(),
            libublk::sys::UBLK_IO_OP_DISCARD | libublk::sys::UBLK_IO_OP_WRITE_ZEROES => {
                device.zero(offset, len as u64)
            }
            other => Err(anyhow!("unsupported ublk op {other}")),
        };
        let res = match result {
            Ok(()) => len as i32,
            Err(e) => {
                tracing::error!("ublk op {op} at {offset}+{len}: {e:#}");
                -libc::EIO
            }
        };
        if let Err(e) = q.complete_io_cmd_unified(
            tag,
            BufDesc::Slice(buf.as_slice()),
            Ok(UblkIORes::Result(res)),
        ) {
            tracing::error!("ublk: completing tag {tag}: {e:?}");
        }
    };
    match UblkQueue::new(qid, dev)
        .and_then(|q| q.submit_fetch_commands_unified(BufDescList::Slices(Some(&bufs))))
    {
        Ok(queue) => queue.wait_and_handle_io(handler),
        Err(e) => tracing::error!("ublk queue {qid}: {e:?}"),
    }
}
