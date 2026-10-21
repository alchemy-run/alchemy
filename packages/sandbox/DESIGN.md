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
machine becomes a **process host** for those processes, and only for them: the
session's later calls still fork onto other machines.

- **Its writes merge periodically**, every few seconds, and once more when the
  last process exits. Then the machine goes back to the pool.
- **Files it's writing are shared live.** These are mostly test output, logs
  and caches, and mostly appended to. Appends stream through the Session
  Durable Object, and other machines read those paths through a small FUSE
  layer over their snapshot, so `tail -f` and a harness's monitor see new
  lines within about a second. All other paths stay plain snapshot files at
  kernel speed.
- **Its ports are reachable.** `localhost:3000` in any later call is forwarded
  to the process host, for the ports its processes listen on.
- **It's billed for its processes,** which for tests is compute either way.

A file a process rewrites in place, like SQLite, needs real read-through, a
round trip per read. That's the point where this becomes a distributed
filesystem, so it stays limited to the few files live processes write. If
agents turn out to need it often, the process host can export those paths over
NFS instead of us writing read-through.

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
Your version is kept as fork issue-42~7f3a. Inspect it, rerun, or apply it.
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

## Build order

Each step is useful alone.

1. **Warm pool.** Pinned sessions start fast. Measure claim plus attach on
   both machine types first.
2. **btrfs.** Format and mount it in `blockd`, behind `filesystem`.
3. **Patches.** `btrfs send` parsing, the overlay's upper layer, and fanotify
   for head paths. Probe fanotify first.
4. **Merge.** The commit log in the Session Durable Object, the conflict check,
   applying patches with group commit, `lww`, kept forks, and `merge`.
5. **Serverless `exec`.** Fork, run in a cgroup, stop what's left, merge.
6. **Automatic.** Process hosts, live files by append streaming, ports.
7. **Only if measured to matter:** the file tree in the store, NFS for files
   rewritten in place, and `kill` across machines.

## What we measure

| Question | Decides |
|---|---|
| Claim plus attach from a warm pool | Whether serverless calls are cheap enough |
| btrfs `fsync` through `blockd`, against ext4's 113–136 ms | Whether btrfs costs anything that matters |
| How often calls conflict, with and without `lww` | Whether file-level conflicts are fine, or hot files need narrow format-aware merges |
| Patches per second one machine can apply | When the file tree in the store is needed |
| Whether fanotify reports every head write on both kernels | ext4 head paths, or the metadata diff |
| Live-file lag for `tail -f` through the FUSE layer | Whether monitors feel live |

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
