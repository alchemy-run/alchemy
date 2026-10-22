# Workspace service design

Workspaces whose commands run on hosts we deploy in the user's AWS account,
with the disks next to them. Cloudflare Workers, Lambda functions and anything
else call in over HTTP. `DESIGN.md` covers the workspace itself (placements,
patches, merges, the contract); `crates/volume/DESIGN.md` covers one disk.
This document covers the service those run on.

## Why

On machines whose disks don't outlive them (Cloudflare containers, Lambda
MicroVMs), every call attaches its fork from object storage and every merge
crosses several networks. Measured on 22 October 2026, four 2–3-second
commands of one session at once:

| | Per forked call, warm | Landing its patch | Four at once |
|---|---|---|---|
| Cloudflare containers | 5–7 s | 3–10 s | 12–13 s |
| Lambda MicroVMs | 3–5 s | 5–10 s | 14–21 s |
| EC2, the same blockd | 0.27–0.52 s | 0.12–0.39 s | 3.8–4.2 s |

The EC2 numbers hold on the smallest instances (c6gd.medium, t4g.small on
spot), with the cache on NVMe or on EBS alike.

## Shape

```text
Worker / Lambda / anything ──HTTPS──▶ front door ──▶ any host ──VPC──▶ the session's host
                                                                      ├─ blockd daemon: disks, forks, caches
                                                                      ├─ a microVM per session or call
                                                                      │    └─ guest agent: exec, apply, checkpoint
                                                                      └─ the session: its head, its commit log
store: S3 (snapshots, patches, journal)   registry: DynamoDB (hosts, sessions, leases)
```

- **A session lives on one host while it's active.** Its head stays mounted
  there, its commit log is in that host's memory and in DynamoDB, and its
  forks run on the same host as local snapshots: nothing is fetched. A host
  that's full places a fork on another host, which attaches it from S3 into
  its own cache.
- **Any host takes any request.** The front door sends it to any healthy
  host; a host that doesn't have the session forwards it to the one that
  does, inside the VPC. A session nobody has is placed on the host whose
  cache holds most of it.
- **The session's host is the authority** for its commit log and merges. The
  control plane is DynamoDB: which host has which session, each host's
  capacity and cache, and leases with epochs (the same fencing the volume
  engine uses), so a host that dies loses its sessions to another host and
  can't write after it.

## Isolation: a microVM per session

Each session (or forked call) runs in a Firecracker microVM. Its disk is the
session's volume: blockd attaches it (ublk) and hands the block device to the
VM as its root drive. One device carries the image and the session's data;
`fsync` in the guest reaches blockd as a flush and lands in the journal, as
it does today.

A filesystem mounted inside a VM can't also be mounted on the host, so the
work that touches files moves into the guest. A small **guest agent**
(vsock) runs commands, applies patches and makes them: overlay or `btrfs
send` exactly as `blockd call` does now, inside the VM. The host's blockd
keeps everything below the filesystem: devices, forks of snapshots, caches,
the store.

A forked call is a block-level fork (an ephemeral attach of the head's
latest snapshot: writes stay on the host, nothing is fetched that the cache
has) booted in its own VM. A call that leaves processes running keeps its VM
for them, which is the process host of `DESIGN.md` with nothing to forward:
it's already on the session's host.

**KVM is the cost.** Firecracker needs `/dev/kvm`. On EC2 that's a bare-metal
instance or nested virtualization, which since February 2026 runs on Intel
C8i, M8i and R8i instances (not Graviton). So the hosts are x86, the
smallest a `c8i.large`. What nested virtualization costs a VM's I/O is the
first thing to measure.

## Images: fast container loading

An image is a volume: the existing image builder turns a Dockerfile into an
ext4 or btrfs disk and imports it as the base head. A session forks it. A
microVM boots from it before it's downloaded, reading only what it touches,
the way Modal starts containers. Three additions make that fast:

- **A prefetch trace per image.** The first boot records which extents it
  read, in order; later attaches fetch them in parallel ahead of the guest.
  Today a cold read of a 10,000-file tree takes 8–12 s because extents
  arrive one at a time, on demand.
- **One block cache per host, by content.** Extents are content-addressed,
  so a host fetches an image once, whatever session or image shares it.
- **Memory snapshots, later.** A microVM snapshotted after its image's
  startup resumes in milliseconds with its processes warm.

Extents are deduplicated, not files: two images holding the same file at
different offsets don't share it. The image builder can lay files out so
common layers line up, later.

## Durability and latency

- **A command answers once its patch is applied** to the head and the head
  has synced its journal. The head's snapshot happens after, in the
  background, and before the next fork that needs a newer base. That takes
  the 0.3–0.6 s snapshot off every command.
- **`fsync` is a journal append**: about 100 ms to S3, about 10 ms to S3
  Express One Zone in the host's zone. The journal store is already
  pluggable.
- **A host that dies** loses only what wasn't synced: the next host to take
  the session folds the journal.

## Built with Alchemy resources

`AWS.Workspace(Workspace, { ... })`, a host Layer for the same
`Sandbox.Workspace` declaration a Worker yields today. It deploys:

- a VPC with public subnets, an S3 bucket for the store, a DynamoDB table for
  the registry;
- a launch template and an Auto Scaling group of hosts (AMI from Ubuntu with
  blockd, Firecracker and the guest kernel installed at boot), with their
  instance role;
- the front door: an Application Load Balancer with a certificate, or a
  Lambda function URL that only places and redirects;
- the image builds, as today.

A Worker reaches it with a token the host Layer mints, through the same
`WorkspaceClient` it uses for Cloudflare's host. Packaging it for others to
deploy comes later.

## Building it

1. **One host.** blockd's daemon boots a Firecracker VM per call and per
   open; the guest agent runs commands and makes patches. Measure on a
   `c8i.large` spot instance: VM boot, call overhead, nested-virtualization
   I/O. Commands run inside the VM; nothing else changes.
2. **The service, one host behind the front door.** `AWS.Workspace`, the
   session on its host with the commit log, a live test from a Worker.
3. **Fast paths.** Forks of a mounted head without an attach, the snapshot
   after the answer, prefetch traces, the shared block cache.
4. **Many hosts.** Placement by cache, forwarding, leases, draining for
   scale-in and spot interruptions.
5. **Egress, ports, memory snapshots.**

## Open

| Question | Decides |
|---|---|
| Firecracker's I/O under nested virtualization on C8i | Whether hosts can be small virtual instances or must be metal |
| Cloud Hypervisor instead (virtio-fs as well as block) | Whether the host could keep files mounted and fork them itself |
| How long a session stays on its host when idle, and what an idle host costs | The pool's floor |
