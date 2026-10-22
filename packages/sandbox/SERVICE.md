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
                                                                      ├─ a container, gVisor sandbox or microVM per session or call
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

## Isolation: containers, gVisor or microVMs

Every host offers all three; a host chooses with `isolation`, and a
workspace doesn't change when its hosts do.

| `isolation` | Boundary | File operations | Runs on | Default for |
|---|---|---|---|---|
| `"container"` | Linux namespaces, seccomp, user namespaces | Native | Any CPU, any size | Self-hosting through Alchemy: the user's own agents in their own account |
| `"gvisor"` | A kernel in user space | 5–50 times slower (below) | Any CPU, any size | Untrusted code where KVM isn't available |
| `"firecracker"` | Hardware virtualization | The guest's own kernel on the block device | Bare metal of any CPU; Intel C8i, M8i, R8i | Our managed service: other people's code on shared hosts |

- **Containers and gVisor are one path.** Both run an OCI bundle: the image
  as a read-only root, the session's disk, as blockd mounts it on the host,
  bind-mounted at the workspace's path. Only the runtime differs (`runc` or
  `runsc`). Everything that works on files stays on the host as it is today:
  overlay and `btrfs send` patches, forks of a mounted head, process hosts.
- **Firecracker is the other.** A filesystem mounted in a VM can't also be
  mounted on the host, so blockd hands the VM the session's block device and
  the file work (running commands, making and applying patches) moves into a
  small agent in the guest. Memory snapshots come with it.

A call that leaves processes running keeps its container or VM for them: the
process host of `DESIGN.md`, already on the session's host.

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

So gVisor is the option for untrusted code without KVM, not a default.
gVisor reading the disk itself (an EROFS image for the read-only part, an
overlay inside the sandbox for writes) instead of host files might close
the gap; untested, and what it makes of patches is the question.

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
  blockd, runc, gVisor and, where there's KVM, Firecracker installed at
  boot), with their
  instance role;
- the front door: an Application Load Balancer with a certificate, or a
  Lambda function URL that only places and redirects;
- the image builds, as today.

A Worker reaches it with a token the host Layer mints, through the same
`WorkspaceClient` it uses for Cloudflare's host. Packaging it for others to
deploy comes later.

## Building it

1. **One host, containers and gVisor.** blockd's daemon runs each call and
   each open's commands in an OCI bundle over the mounted fork, with `runc`
   or `runsc`.
2. **The service, one host behind the front door.** `AWS.Workspace`, the
   session on its host with the commit log, a live test from a Worker.
3. **Fast paths.** Forks of a mounted head without an attach, the snapshot
   after the answer, prefetch traces, the shared block cache.
4. **Many hosts.** Placement by cache, forwarding, leases, draining for
   scale-in and spot interruptions.
5. **Firecracker hosts**: the guest agent, memory snapshots; measured on
   metal and under nested virtualization.
6. **Egress, ports.**

## Status

Built and tested live (22 October 2026), `test/Sandbox/WorkspaceService.test.ts`:
a Cloudflare Worker using a workspace whose host is a t4g.small spot
instance, containers (runc) on a `node:24-bookworm-slim` image.

- Commands on forks merge back, a colliding one is refused whole and kept
  as a fork, a command that leaves processes running keeps them and later
  commands see what they write, opens run commands on the mounted head and
  reach a server on its port, and fork, merge, history, undo and delete.
- From the test, through the Worker and the load balancer: four 2-second
  commands at once in 4.7 s. A warm forked call: 0.34 s on the host (0.15 s
  of it starting its container), plus up to 0.6 s for the head's snapshot
  when changes landed since the last one.
- The first command on a fresh host: 4.5 s, nearly all of it Node loading
  from an image no one had read yet. Prefetch traces are for that.

## Open

| Question | Decides |
|---|---|
| What a microVM's file operations cost on its own block device, under nested virtualization and on metal | Whether microVMs are the default where there's KVM |
| Firecracker's I/O under nested virtualization on C8i | What the hardware-isolated option costs |
| How long a session stays on its host when idle, and what an idle host costs | The pool's floor |
