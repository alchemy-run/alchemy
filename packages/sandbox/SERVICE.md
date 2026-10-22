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
                                                                      ├─ a sandbox per session or call (gVisor)
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

## Isolation: gVisor, or a microVM where there's KVM

Hosts run on any CPU (Graviton, AMD, Intel) at any size, so the default
isolation needs no hardware virtualization.

- **gVisor** (the default). Each session or forked call runs in a gVisor
  sandbox (Systrap): its system calls are handled by a kernel in user space,
  so it needs no `/dev/kvm` and runs on every instance type. Its root is the
  session's disk as blockd mounts it on the host, so everything that works
  on files stays on the host as it is today: overlay and `btrfs send`
  patches, forks of a mounted head, process hosts. System-call-heavy work
  runs slower; for coding agents (builds, git, grep, many small files) that
  is what to measure.
- **Firecracker**, where KVM exists: bare-metal instances of any CPU, or
  Intel C8i, M8i and R8i with nested virtualization. A hardware boundary
  and memory snapshots, for tenants that need them. A filesystem mounted
  in a VM can't also be mounted on the host, so with Firecracker the file
  work (running commands, making and applying patches) moves into a small
  agent in the guest, and blockd hands the VM the session's block device.

Both sit under the same daemon API: a workspace doesn't change when its
hosts do. A call that leaves processes running keeps its sandbox for them:
the process host of `DESIGN.md`, already on the session's host.

### What gVisor costs (measured)

t4g.small spot, the session's head mounted by blockd (ext4, ublk), gVisor
release-20261012.0 (Systrap) running a container with the volume
bind-mounted at `/work` (`crates/blockd/tests/ec2/gvisor.sh`). Each gVisor
time includes starting the sandbox, about 0.2 s.

| Workload | Host | gVisor |
|---|---|---|
| `cp -a` of 10,000 small files | 0.43 s | 7.0–7.2 s |
| `git add -A && git commit` of them | 1.6–1.8 s | 11.1–11.7 s |
| `git status` | 0.023 s | 1.2 s |
| `grep -r` | 0.26–0.44 s | 0.88–0.93 s |
| Find and read every file | 0.16–0.17 s | 2.5–4.0 s |
| Write 5,000 small files | 0.28–0.34 s | 1.6–1.8 s |
| 200 writes with `fsync` | 19.1–19.6 s | 20.3–20.4 s |
| `sh -c` 100 times | 0.06 s | 0.51–0.54 s |

btrfs is the same. Telling gVisor it owns the mount
(`--file-access-mounts=exclusive`) changes nothing that matters. Every file
operation crosses from gVisor's kernel to the host, and coding work is made
of small file operations: gVisor is 5–50 times slower at exactly what agents
do most. `fsync` passes through, so durability holds. (`runsc do` looks
faster, but its writes go to an overlay of its own and never reach the
volume.)

So gVisor isn't a good default here. What's left:

- **A microVM where there's KVM.** The guest's own kernel runs the
  filesystem on the block device, so file operations stay inside the VM.
- **Plain containers** (namespaces, seccomp, user namespaces): native speed
  on any CPU, a weaker boundary. A fit when the hosts run in the user's own
  account for their own agents.
- **gVisor over a disk it reads itself** (an EROFS image for the read-only
  part, an overlay inside the sandbox for writes) instead of host files.
  Untested: what it makes of patches is the question.

## Images: fast container loading

An image is a volume: the existing image builder turns a Dockerfile into an
ext4 or btrfs disk and imports it as the base head. A session forks it. A
sandbox starts from it before it's downloaded, reading only what it touches,
the way Modal starts containers. Three additions make that fast:

- **A prefetch trace per image.** The first boot records which extents it
  read, in order; later attaches fetch them in parallel ahead of the guest.
  Today a cold read of a 10,000-file tree takes 8–12 s because extents
  arrive one at a time, on demand.
- **One block cache per host, by content.** Extents are content-addressed,
  so a host fetches an image once, whatever session or image shares it.
- **Memory snapshots, later.** A sandbox checkpointed after its image's
  startup resumes with its processes warm.

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
  blockd and gVisor installed at boot), with their
  instance role;
- the front door: an Application Load Balancer with a certificate, or a
  Lambda function URL that only places and redirects;
- the image builds, as today.

A Worker reaches it with a token the host Layer mints, through the same
`WorkspaceClient` it uses for Cloudflare's host. Packaging it for others to
deploy comes later.

## Building it

1. **One host.** blockd's daemon runs each call and each open's commands in
   a gVisor sandbox over the mounted fork. Measure on a small Graviton spot
   instance what gVisor costs coding workloads against the bare host.
2. **The service, one host behind the front door.** `AWS.Workspace`, the
   session on its host with the commit log, a live test from a Worker.
3. **Fast paths.** Forks of a mounted head without an attach, the snapshot
   after the answer, prefetch traces, the shared block cache.
4. **Many hosts.** Placement by cache, forwarding, leases, draining for
   scale-in and spot interruptions.
5. **Egress, ports; Firecracker hosts, and memory snapshots on them.**

## Open

| Question | Decides |
|---|---|
| What a microVM's file operations cost on its own block device, under nested virtualization and on metal | Whether microVMs are the default where there's KVM |
| Whether plain containers are enough for one account's own agents | The default on every other host |
| Firecracker's I/O under nested virtualization on C8i | What the hardware-isolated option costs |
| How long a session stays on its host when idle, and what an idle host costs | The pool's floor |
