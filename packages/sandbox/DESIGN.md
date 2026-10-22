# Workspace design

A workspace is a set of forkable, undoable disks that live in object storage,
one disk per session. `crates/volume/DESIGN.md` covers how one disk is stored
and kept durable. This document covers everything above that: where commands
run, which filesystem they see, and how several machines work on one session
without breaking it.

## What we need

Three ways of running, on every host, from one contract.

1. **Pinned.** Every call in a session runs on one machine, like an ordinary
   sandbox. The difference is the disk: it's a volume, so it survives the
   machine, forks instantly and undoes per call. The ephemeral disk of a
   Cloudflare container or a Lambda MicroVM survives none of that. Background
   processes, `tail`, `localhost` ports and job control all work, because
   nothing moves.
2. **Serverless.** Every call can run on any machine. A call forks the
   session, runs, and merges back. Many calls run in parallel on many
   machines, and nothing is billed while the model thinks. This is for
   harnesses written for it.
3. **Automatic.** Calls run serverless until one leaves processes running.
   Its machine then stays up for those processes, the files they write are
   shared live, and their ports are reachable from every other call. An
   off-the-shelf harness that runs tests in the background and monitors their
   output works without knowing any of this.

Any filesystem, on any way of attaching a disk, on any host:

| | Cloudflare container | Lambda MicroVM | EC2, ECS on EC2 |
|---|---|---|---|
| Kernel | 6.18 `cloudflare-microvm` | 6.1 Amazon Linux 2023 | The AMI's |
| Attach | FUSE file + loop | FUSE file + loop | ublk, NBD fallback |
| ext4 | Yes | Yes | Yes |
| btrfs | Yes, built in | No | Ubuntu yes, AL2023 no |
| overlayfs | Yes | Yes | Yes |

Probed on 21 October 2026. On Cloudflare, a btrfs snapshot took 15 ms, and
`btrfs send` of a 4 KiB change to a 64 MiB file plus an edit, a rename, two
deletes and a new directory was a 5 KB stream, made in 8 ms.

**Never hide anything from the model.** A conflict, a stopped background
process or a refused merge shows up in the call's output, in words. The model
can adapt to anything it's told. It can't adapt to output that contradicts the
disk.

**Never merge file contents.** Two calls that changed the same file conflict.
There's no line-level merge: a clean text merge can still break the build, and
nobody reviews it. The model resolves conflicts itself, with ordinary edits.

## Layers

Each layer is chosen independently. A choice in one never changes another's
code.

| Layer | Choices | Chosen by |
|---|---|---|
| Store | The volume engine: manifests, journal, leases | Fixed |
| Attach | ublk, NBD, FUSE file + loop | The host, from what its kernel has |
| Filesystem | ext4, btrfs | The workspace, at deploy |
| Changes | btrfs send, overlay, ext4 diff | The filesystem |
| Placement | pinned, serverless, automatic | Each call |
| Commit | direct, merge | The placement |

The store, attach and the volume engine exist today. Everything below is new.

## Filesystems

`filesystem: "ext4" | "btrfs"` on the host, `ext4` by default. The base image
is formatted with it when the workspace deploys, and `blockd` mounts what the
volume holds. A host whose kernel lacks the filesystem fails at deploy, not at
the first call.

btrfs is the better filesystem for merging, because its metadata records what
changed between two snapshots. ext4 is the better filesystem everywhere else:
it's in every kernel and its `fsync` is a little cheaper. Both keep the same
durability promise, because both sit on the same volume.

## Changes: what a call wrote

A merge needs two things from a call: which paths it changed, and what it
changed them to. Every filesystem produces the same **patch**, a list of
operations on paths:

```text
write   src/world.ts                 whole file, or byte ranges
delete  src/old.ts
mkdir   newdir
rename  src/a.ts -> src/b.ts
link    ...   symlink   ...   chmod   ...   xattr   ...
```

How the patch is made depends on the filesystem:

- **btrfs: `btrfs send`.** The fork takes a read-only snapshot of its base
  when it starts. At the end, `btrfs send -p base current` gives every change
  as a stream, with writes as byte ranges, so a 4 KiB change to a 1 GB SQLite
  file is a 4 KiB patch. We parse the stream ourselves rather than run
  `btrfs receive`: `receive` can only rebuild the fork's own snapshot on top
  of its base, and a merge applies the patch to a head that has moved since.
- **ext4: an overlay.** The call runs in an overlay whose lower layer is the
  fork's base, mounted read-only, and whose upper layer is scratch space. At
  the end, the upper layer is the patch: changed files whole, deletes as
  whiteouts. The cost is copy-up: the first write to a file copies all of it.
- **ext4 without an overlay: a metadata diff.** The volume knows which extents
  changed. The changed inode-table and directory blocks name the changed
  inodes, and a walk of the directory tree turns them into paths. It's the
  fallback, for hosts where an overlay can't mount.

The head also changes on its own, when a pinned machine writes it directly.
For those writes a merge needs only the paths, because their contents are
already in the head. On btrfs they come from `btrfs send` between the head's
snapshots. On ext4 they come from fanotify on the head's mount
(`FAN_REPORT_DFID_NAME`, in both kernels above, not yet probed).

## Placement

### Pinned

A session holds one machine from its first call until it has been idle for
`machine.idle` with no process running. Its machine holds the head's lease and
writes the head directly, as `open` does today: `fsync` is journaled, and each
call ends in a snapshot. Egress is set per session.

Machines come from a **warm pool**: machines already booted from the
workspace's image, with `blockd` running and no volume attached. Claiming one
attaches the session's head, which fetches only the extents its commands read.

- One pool per workspace and image. A pooled machine never serves another
  workspace.
- Between sessions, a machine kills every process, unmounts, and wipes its
  scratch space. It retires after a fixed number of sessions rather than
  trusting the wipe forever.
- The pool keeps a small floor of warm machines and grows with the demand it
  sees. A claim that finds it empty starts a machine cold.

### Serverless

A call forks the session's head at its latest commit, runs on any pooled
machine, and merges its patch back. Calls in the same turn run on different
machines at once. Egress can differ per call.

A call runs in its own cgroup. Processes still running when its command
returns are stopped, and the output says so:

```text
1 background process (next dev) was stopped when this command ended.
```

### Automatic

Serverless, except a call that leaves processes running isn't stopped. Its
machine becomes a **process host**: the fork stays mounted, its processes
keep running, and the machine stays out of the pool until they exit.

- **The session's next calls run on the host**, in the same mount, so they
  see exactly what its processes see: files as they're written (`tail -f`,
  a harness's monitor), ports on `localhost`, `kill`. The machine is running
  for those processes anyway, so this costs nothing extra; what it gives up
  is fanning that session out while the host lives.
- **What changes there merges every few seconds** and after each call,
  with the same conflict check as any call. A host never conflicts with its
  own earlier commits.
- **When its last process exits**, the host makes a last commit and goes
  back to the pool.
- **A host whose changes conflict stops merging.** When it ends, everything
  it changed since its fork is kept as a session of its own, and every call
  that ran there in between said so.

Streaming its files to calls on other machines and forwarding its ports
(so the session could fan out while a host lives) are possible later; nothing
here depends on them.

A file a process rewrites in place, like SQLite, merges whole. If agents turn
out to need live sharing across machines, the process host can export the
paths its processes write over NFS.

## Merge

A merge is a three-way merge at the level of whole files: the call's **base**
(the head when it forked), **ours** (the head now) and **theirs** (the call's
patch).

- A path changed only by theirs takes their change.
- A path changed by both is a **conflict**, unless it matches `lww`.
- `lww` paths take the newest change. Lockfiles, `dist/`, caches and coverage
  go here, so two builds don't conflict over their own output.
- Deleting a file the other side changed is a conflict. So is deleting a
  directory the other side added files to. A rename is a delete and a create.
- Mode, owner and xattr changes are changes to their path.

A conflict refuses the **whole** call: nothing it wrote lands. Applying half of
it, say `node_modules` without `package-lock.json`, would leave a disk no shell
could ever produce. The call's output says what happened:

```text
Not applied: another agent changed these files since this command started:
  src/world.ts  (yours: +40 -3, theirs: +12 -1)
Its version is kept as session issue-42.conflict-7f3a: inspect it, rerun the command, or apply it.
```

The refused fork is kept, so nothing is lost: the model can read it, rerun the
command, or force its version in.

**Who applies a patch.** Whoever holds the head's lease: the pinned machine if
the session has one, otherwise any pooled machine that takes the lease for a
batch. It applies every waiting patch and snapshots once (group commit, as the
journal does for `fsync`). The Session Durable Object keeps the commit log:
each commit's sequence number and the paths it changed. Checking a patch for
conflicts reads that log back to the patch's base.

**Later: a file tree in the store.** If one machine applying patches caps
throughput, the head's file tree (paths to content) can live next to its
blocks, and the Session Durable Object merges trees without a machine. Nothing
before that depends on it.

## The contract

| | Today | New |
|---|---|---|
| `open(session, options, effect)` | Mounts for the effect | Pinned for the effect |
| `exec(session, command)` | `open` around one command | Serverless or automatic, by the host's `machine.placement` |
| `fork`, `undo`, `history`, `delete` | | Unchanged |
| `merge(from, into)` | | New: the same file-level merge, for whole forks |

`WorkspaceExecOutput` gains what happened to the call's changes:

```ts
interface WorkspaceExecOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly changes:
    | { readonly status: "applied"; readonly snapshot: Snapshot }
    | { readonly status: "conflict"; readonly paths: ReadonlyArray<string>; readonly fork: string };
}
```

Harness adapters append the conflict notice to the output an off-the-shelf
harness sees. A harness we write reads `changes` directly.

`lww` changes what a merge means, so it goes on the declaration. The filesystem,
placement and pool are tuning, so they go on the host:

```ts
export class Workspace extends Sandbox.Workspace<Workspace>()("Workspace", {
  lww: ["pnpm-lock.yaml", "dist/**", "coverage/**", "**/.cache/**"],
}) {}

Cloudflare.Containers.Workspace(Workspace, {
  dockerfile,
  path: "/workspace",
  filesystem: "btrfs",
  machine: { placement: "automatic", idle: "1 minute", pool: { min: 2 } },
});
```

## blockd, one daemon per machine

Today each forked call starts a new `blockd call` process through the host's
`exec`, which opens the store, reads the snapshot's manifest, attaches,
mounts, runs, patches, unmounts and exits. A mounted head is another `blockd`
process with its own socket. A forked call costs four or more `exec`s: the
call, reading its result, removing its log, the wipe. On a Lambda MicroVM,
every one of those is a new WebSocket to the MicroVM's public endpoint.

Instead, one `blockd daemon` runs per machine for as long as the machine
does, and owns everything on it: every mounted head, every forked call, every
cache. The orchestrator talks to it over HTTP.

```text
orchestrator ──HTTP──▶ blockd daemon ──▶ store (S3, R2, GCS)
 (a Durable Object,     ├─ heads: mounted, leased, journaled
  a controller on EKS)  ├─ calls: forks, their commands, their patches
                        └─ caches: snapshot metadata, store connections, blocks
```

### What it keeps between requests

- **Open stores.** One client per store, with its pooled connections and its
  cache of manifests and pages. A fork of a snapshot the daemon has seen
  reads no metadata.
- **Cache files.** A cache file left by a clean detach is reused by the next
  attach of any snapshot that shares its extents, as today. The daemon hands
  each attach a free cache file, so attaches can run at once.
- **Mounted heads**, with their flusher and change tracking, as `blockd
  mount` keeps them today.
- **Calls**, running or kept: the fork, its command's process group, its
  output, and the commits made so far.

### The API

JSON over HTTP/1.1, with a bearer token on every request.

| Request | Does |
|---|---|
| `GET /v1/status` | The daemon's heads, calls, caches and counters |
| `POST /v1/heads` | Mount a head (lease, attach, mount, start tracking) |
| `POST /v1/heads/<head>/<op>` | `sync`, `snapshot`, `checkpoint`, `apply`, `detach`, `status` |
| `POST /v1/calls` | Start a command on a fork of a snapshot; returns its id |
| `GET /v1/calls/<id>?wait=<ms>` | Its result once done, or `{ "done": false }` after `wait` |
| `POST /v1/calls/<id>/<op>` | A kept call's `commit`, `status`, `detach` |
| `POST /v1/diffs` | A patch from one snapshot to another |

A call is started and then waited on, so a command that runs for an hour
never holds one HTTP request open for an hour, and an orchestrator that
restarts finds its calls again by id.

Every reply carries `timings`: milliseconds per phase (attach, mount, run,
settle, commit, upload, unmount for a call; lease, attach, mount for a head;
checkpoint, fetch, apply for an apply). The orchestrator adds its own (pool
claim, machine start, head mount, commit queue) and the call's result reports
them all.

### Where it runs

| | Cloudflare container | Lambda MicroVM | EC2 | EKS |
|---|---|---|---|---|
| Started by | an `exec` before each mount or call, a no-op while it runs | the same | systemd | a DaemonSet |
| Reached at | the container's port | the MicroVM's port | the instance's address | the node's address |
| Store credentials | its environment | its environment | the instance role | the pod's role (IRSA) |
| Cache | the container's disk | the MicroVM's disk | local NVMe | the node's NVMe (hostPath) |
| Calls at once | one (one session per machine) | one | many | many |

On Cloudflare and Lambda the daemon dies with its machine, and the next mount
or call starts it again: that's the one `exec` left per call. On EC2 and EKS it outlives every session, so its
caches stay warm for the life of the instance.

**The command's environment is its own.** The daemon's environment holds the
store's credentials; a command gets the daemon's environment without
`AWS_*` and `BLOCKD_*`, plus what the request asks for. (Today's `blockd
call` passes its whole environment on.)

**One crash takes every mount on the machine.** A head's synced writes are in
its journal, so the next mount folds them, as when a `blockd mount` dies
today. Calls that were running are lost and say so.

### Later, on EC2 and EKS

- **One block cache per machine, by content.** Extents are content-addressed
  (each manifest entry names its chunk's hash), so one cache on NVMe keyed by
  chunk hash serves every head and every fork on the machine, of every
  session. The base image is fetched once per machine, not once per attach.
  Each attach keeps only the blocks it wrote in a file of its own. A pool of
  SSD cache machines can sit behind it as a second tier before the store.
- **Forks without an attach.** A call placed on the machine that has its
  session's head mounted forks it locally: a btrfs snapshot of the mounted
  head, or an overlay over a frozen snapshot of it. Nothing is fetched.
- **Commands in other containers.** On EKS the daemon's mounts reach a pod
  through a hostPath with mount propagation, and the command runs in the
  pod. The call API splits into fork, commit and close for that, with the
  command run by whoever owns the pod.
- **Placement by cache.** The orchestrator places a call on the machine whose
  cache already holds most of its snapshot, from `GET /v1/status`.

## Status

Built and tested live (21 October 2026):

- **Warm pool**, sessions on pooled machines (`Workspace.test.ts`, 8/8).
- **btrfs** volumes: data as the default subvolume, snapshots and `send`
  through ioctls, so images need no btrfs-progs.
- **Patches** from overlays and `btrfs send`, byte ranges for in-place
  writes; head checkpoints by fanotify (ext4) and snapshots (btrfs).
- **Merge**: the commit log, conflict check, `lww`, kept forks, group
  commit, `merge(from, into)` with recorded merge bases.
- **Serverless and automatic placement**, process hosts
  (`WorkspaceMerge.test.ts` on Cloudflare with btrfs, 6/6;
  `WorkspaceLambda.test.ts` on MicroVMs with ext4).
- Local end-to-end tests: `crates/blockd/tests/merge/run.sh` (ext4 and
  btrfs).

First numbers, Cloudflare containers, btrfs: four 3-second commands of one
session at once took 8.7 s with warm machines and 18.7 s cold. A 4 KiB write
to an 8 MiB file merges as a 4,115-byte patch on btrfs (the whole file on
ext4).

**blockd as a daemon** (22 October 2026): every mount, call and diff goes
through one `blockd daemon` per machine over HTTP; local tests in
`crates/blockd/tests/daemon/run.sh` (ext4 and btrfs). Each command's result
carries `timings`. Four 2–3-second commands of one session at once:

| | Exec per step | Daemon |
|---|---|---|
| Lambda MicroVMs, ext4, first round | 34.3 s | 21.0 s |
| Lambda MicroVMs, ext4, again | | 14.2 s, 18.5 s |
| Cloudflare containers, btrfs, warm | 15.0 s | 11.9 s, 13.0 s |

Once the daemon runs, it costs under 0.1 s a call. On a warm machine a
forked call now spends 0.2–0.6 s attaching, 0.25–1.7 s mounting (btrfs on
Cloudflare is the slow end), 0.2–0.3 s uploading its patch, and then 3–10 s
landing it: about 2 s for the head's snapshot, 0.3–1.5 s applying, and the
rest queued behind the batch before it. `fsync` on a MicroVM: 120 ms at the
median.

**The same daemon on EC2** (22 October 2026, `crates/blockd/tests/ec2/daemon.sh`):
m7gd.large (Graviton), cache on instance NVMe, ublk, store in S3 in the same
region, commands run on the host. Warm, per command:

| | ext4 | btrfs |
|---|---|---|
| Forked call, around a trivial command | 0.28–0.34 s | 0.38–0.52 s |
| of which mount | 57–70 ms | 170–320 ms |
| of which making the patch | 45–57 ms | 5 ms |
| Landing it on the mounted head | 0.12 s | 0.33–0.38 s |
| Snapshotting the head | 0.47–0.58 s | 0.27–0.30 s |
| Four 2-second commands at once, snapshot to snapshot | 3.8 s | 4.0 s |
| `fsync` on the head | 93 ms | 110 ms |

A cold read of the whole base (10,000 small files and 64 MiB) took 12.2 s
(ext4) and 7.8 s (btrfs): extents are fetched one at a time on demand.

Not built: streaming live files and forwarding ports across machines, the
file tree in the store, `kill` across machines.

## What we measure next

| Question | Decides |
|---|---|
| Whether a commit can answer once its patch is applied and journaled, snapshotting only before the next fork | Most of the 3–10 s a forked call spends landing |
| What a btrfs fork's 1–1.7 s mount on Cloudflare is (FUSE, loop, `mount`, the two snapshots) | The rest of a warm call's overhead |
| btrfs `fsync` through `blockd`, against ext4's 113–136 ms | Whether btrfs costs anything that matters |
| How often calls conflict, with and without `lww` | Whether file-level conflicts are fine |
| Patches per second one machine applies | When the file tree in the store is needed |

## Prior work

- **LayerFS** ([repo](https://github.com/Ephemeral-AI-Lab/layerfs)): a
  workspace per Bash call over shared history, commits that refuse same-file
  conflicts, `.lww`, file tools that skip the mount. Its v1 has no answer for
  processes that outlive a call.
- **Archil**: per-file delegations on a shared disk, so no lost-update
  protection and no per-call atomicity; serverless exec capped at 5 minutes,
  with persistent sandboxes for anything long-lived.
- **Coda**: optimistic replication that rejects update/update conflicts on
  reintegration.
- **Delta Lake, Iceberg, lakeFS**: snapshot reads and commits that check
  concurrent writes to the same files.
- **Merge queues** (Uber's SubmitQueue, GitHub, Bors): changes that are fine
  alone and broken together.
- **`try`** (binpash): run a command in an overlay, then commit or discard it.
- **btrfs send/receive**: changes between snapshots, from metadata.
