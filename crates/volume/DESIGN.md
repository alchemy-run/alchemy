# Volume design

A workspace session is a disk. It lives in object storage, is mounted on a
machine only while an `open` runs, forks instantly and undoes one `open` at a
time. This document is the storage engine behind that: what it guarantees, how
it works, and which lessons it takes from systems that solved parts of the
problem before us.

We build it ourselves. None of the systems below does all of what we need, but
each paid for a lesson we shouldn't pay for again. Every rule here that came
from one of them says so.

## What we need

1. **Machines hold no state.** Any machine in the pool can serve any session.
   A dead machine loses nothing that was acknowledged.
2. **`fsync` means durable.** When the kernel's ext4 sends FLUSH or FUA, the
   write survives losing the machine.
3. **An `open` is one undo point.** Many `fsync`s inside one `open` don't
   create many snapshots. An `open` that fails or is interrupted still ends in
   a snapshot.
4. **Fork and undo cost nothing.** They move pointers; they never copy data.
5. **Attach is fast.** A machine reads only the blocks a command touches, and
   blocks shared between forks are fetched once per machine.
6. **No merge.** Forks are explore-and-pick. Keeping one is moving a head.

## The three levels of durability

The engine used to have one event, the flush, which was both `fsync` and
snapshot. Splitting it is the central change. Following SlateDB's durability
levels (RFC 0008), a write passes through three:

| Level | Reached when | Survives | Cost |
|---|---|---|---|
| **Cached** | A write lands in the machine's cache file | Nothing; lost with the machine | A local write |
| **Journaled** | `fsync` (FLUSH/FUA), or the background flush | Losing the machine | One PUT, shared by every concurrent `fsync` |
| **Snapshotted** | The `open` ends | Everything; it's an undo point | A pack, its pages, a manifest, a head move |

An `fsync` waits for the journal, never for a snapshot. A snapshot is built
from the journal, so it never needs the machine that wrote it.

## Objects

Everything is immutable and written once. Content-addressed objects are named
by the hash of their bytes. The journal is named by position.

```text
packs/{hash}                         compressed extents
pages/{hash}                         1024 extent → (pack, offset, len) entries
manifests/{hash}                     size, parent, page hashes: one snapshot
heads/{session}                      the head's record (below)
journal/{session}/{epoch}/{seq}      dirty blocks since the last snapshot
                                     (or in the Session Durable Object; see below)
```

A head is the only mutable thing: session id → (manifest, epoch, journal
position, an unfolded earlier journal, a tombstone flag). On Cloudflare the
Session Durable Object is its authority: it caches the record and writes
every change through to `heads/{session}` with a conditional PUT, so R2 stays
the store of record (garbage collection and history read it there) while
every read `blockd` makes is answered from the object's memory. The object is
strongly consistent. That's an advantage SlateDB and ZeroFS don't have: they build
compare-and-swap out of object-store preconditions, and SlateDB needed
two-phase writes and a transactional side store for S3 before it had
preconditions (RFC 0001). We get a linearizable coordinator for free and use
the object store only for immutable bytes.

**Order of writes (ZeroFS's barrier).** Bytes go up before anything that
points at them: pack before pages, pages before manifest, manifest before the
head moves. A crash can leave an object nothing points at, which garbage
collection removes. It can never leave a pointer to an object that isn't there.

## Leases and fencing

Only one machine writes a session at a time. When a machine mounts a session,
it takes a lease: it bumps the head's **epoch** with a compare-and-swap. The
epoch is in every journal key, and a head move only succeeds from the record
the lease last wrote, so a superseded writer can't move the head.

That's SlateDB's writer epoch (RFC 0001). Putting the epoch in the object key
comes from ZeroFS, whose segment keys are `{shard}/{epoch}/{counter}`: two
writers can never collide on a name.

**The fence is a check after each append, not an object.** Our first version
fenced the way SlateDB does, by writing a marker into the old writer's next
journal position. The simulation found the hole SlateDB's RFC 0026 describes:
once recovery deletes the folded journal, marker included, the position is
free again, and a stalled writer can write there and acknowledge an `fsync`
nobody will ever read. So every append, after its entry lands, reads the head
and checks the epoch is still its own. A new lease bumps the epoch *before* it
reads the old journal, so an entry that landed before the bump gets folded,
and one that landed after fails its check. The cost is one read of the head
per `fsync`, which is cheap when heads live in a Durable Object.

**Epochs never repeat for a name.** Deleting a head leaves a tombstone with its
last epoch, and creating the name again continues from there. Without it, a
re-created head would start at epoch 0 again, and both a leftover journal entry
and a still-running old writer could pass for the new head's.

A machine that loses its lease must stop. Its next FLUSH fails with an I/O
error, the kernel's ext4 goes read-only, and the commands in that `open` fail.
It never acknowledges an `fsync` it can't make durable. ZeroFS calls this a
verified `fsync`: after a lineage break, `fsync` returns an error rather than a
false success.

## The journal

The journal holds every block written since the session's last snapshot.

- **Group commit.** `fsync`s that arrive while a journal write is in flight
  wait for the next one, which carries all of their blocks: one PUT per round,
  however many callers. This is RocksDB's and SlateDB's commit pipeline. No
  artificial delay: a lone `fsync` goes out immediately.
- **Background flush.** Many programs never `fsync` (package managers
  rarely do), so dirty blocks are also journaled every few seconds while the
  session is dirty, bounding what a machine crash can lose. ZeroFS flushes every
  30 seconds by default; ext4 itself commits every 5.
- **Contiguous positions.** Journal entries are numbered `0, 1, 2, …` within
  an epoch, written one at a time, and each is written only if its name is
  free. Recovery reads up to the first missing entry, so it can't apply a later
  write while missing an earlier one. That's ZeroFS's ordering rule: the
  recovered state is a prefix of acknowledged writes, never a subset.
- **Lost responses.** A write can land with its reply lost. A retried append
  that finds its own bytes at its position counts as done; a compare-and-swap
  that reports a conflict is re-read, and counts as done if the head already
  holds what it wrote. Clients like `object_store` retry internally, so both
  happen in practice.
- **Block granularity.** The journal stores 4 KiB blocks, not whole extents,
  so a small write to a large file costs a small journal entry. Snapshots keep
  extent granularity; the fold reads the base extent and applies the blocks.
- **Each entry has a checksum.** A torn or truncated entry ends the prefix.
- **A pluggable store** (`volume::store::JournalStore`). SlateDB lets the WAL
  live on a different, faster store than the data (RFC 0009), because WAL
  latency is what bounds `fsync`. Ours: entries as blobs, checked against the
  head store after each write (the default), or kept by the coordinator that
  holds the head, which appends and checks the lease in one atomic request
  (`HttpJournalStore`, `blockd --journal`). On Cloudflare the Session Durable
  Object keeps them in its SQLite storage, 256 blocks per entry (its values are
  capped at 2 MiB), and deletes them when the head moves past them. This is our
  answer to Archil's sub-millisecond `fsync`, which comes from their replicated
  SSD tier: we don't run a server tier, but the journal sits on the fastest
  durable store the host has.

## Snapshots

When an `open` ends, its machine folds the journal into a snapshot:

1. Freeze the filesystem (`fsfreeze`), so ext4 is consistent on disk.
2. Write the last journal entry.
3. Build packs from the dirty extents; upload packs and pages in parallel.
4. Upload the manifest.
5. Ask the Session Durable Object to move the head from the old manifest to
   the new one and reset the journal position, checking the lease's epoch.
6. Delete the folded journal entries.

If the machine dies between 2 and 5, the journal is durable and any machine
can do the fold. The next lease for the session first folds whatever journal
the last epoch left, so a crashed `open` still ends in a snapshot, as the
contract requires.

Neon works the same way at a different layer. Its write-ahead log is the
durable truth, and the page server materializes image layers from it later.
Our snapshot is the image layer, and we materialize one per `open` so reads
never consult a long journal.

**Later, if open-end latency matters:** step 2 alone makes the `open` durable.
Steps 3 to 6 could run after the `open` returns, with the Durable Object
recording a journal mark as the undo point. A fork or undo of an unfolded mark
would wait for the fold. We start with the synchronous fold and measure first.

## Fork and undo

A fork is a new head on an existing manifest, and an undo moves a head to its
manifest's parent. Neither touches the object store. Both go through the
Session Durable Object, and both wait for an in-flight fold on the session
they read, so they never act on an `open` that hasn't finished.

## Reads

A machine reads a session's blocks lazily: a missing block fetches its whole
extent with one ranged GET, and ranges that sit next to each other in one pack
coalesce into one GET (ZeroFS). Sequential reads trigger readahead.

The cache file is keyed by content hash, so an extent shared by a base image
and all its forks is fetched once per machine. That makes warm pools work:
a machine that just served one fork of a repo has most of every other fork
already. Lambda's container loading
([Brooker et al., ATC 2023](https://www.usenix.org/conference/atc23/presentation/brooker))
showed that content-addressed chunks shared across images, plus a tiered cache,
is what makes lazy loading fast at scale. A shared cache tier between the
machine and R2 is a later step.

**Attach prefetch.** Each session records which extents its first seconds of
every `open` read, and the next attach prefetches them while the first command
starts. This one is our idea, not borrowed, so it's on the list of things to
measure.

## Garbage collection

Mark and sweep from every head in `heads/`. Journal entries are kept or
deleted by their head's record, with no age guess: an entry is needed only if
it's at or past the record's position in the current epoch, or in the unfolded
earlier journal. On Cloudflare each machine runs a collection at most every six
hours, after an `open` ends, off the caller's path.

Snapshot objects (packs, pages, manifests) that no head reaches yet may belong
to a commit in flight: it uploads them before it moves the head. A grace period
alone (an hour) is a guess that the commit finishes in time, and SlateDB's
GC-boundary RFC (0026) describes how such guesses fail: a writer that stalls
past the window gets its objects deleted underneath it. So:

- **The boundary is the oldest live lease.** Every lease writes an empty
  marker, `leases/{head}/{epoch}`, when it begins, and deletes it when it ends.
  Collection spares anything written since the oldest marker that's still for
  its head's current epoch (a superseded lease can't commit), however long ago
  that was. A marker its machine never deleted stops counting once another
  lease supersedes it, or after a day. Markers use the store's modification
  time, so writers need no clock.
- **A stale writer can't be resurrected.** Its epoch is fenced, so its objects
  are never pointed at, even if they're uploaded after collection.
- **History has a retention policy.** Undo depth per session is a policy
  (default: keep all), and forks keep their parents' snapshots alive by
  reference, like Neon's branch points and SlateDB's clone references.
- **Fragmented packs are repacked.** Once old snapshots are dropped, a pack
  can be mostly dead. ZeroFS tracks live bytes per segment and repacks above
  10% dead; we measure how much this happens with forked histories before
  building it.

## Testing

ZeroFS's test suite is the part most worth copying, because it's where the
guarantees come from. Ours is in `tests/lease.rs` and `crates/blockd/tests`.
The simulation found the fence hole above on its first run, and removing any
one of the safeguards (the check after append, recovery, the pending journal,
the lost-response handling) makes it fail on its first seed.

1. **Deterministic simulation.** The engine runs over an in-memory store with
   seeded faults: a request fails before doing anything, lands with its reply
   lost, or is done twice because the client retried. Writers crash at random,
   on every failed request, and when another machine attaches while they still
   run, after which they keep trying to write and must fail. After each
   recovery, an oracle checks the disk is exactly what was acknowledged, or that
   plus the one operation whose fate was unknown. Garbage collection runs
   between steps. `VOLUME_SIM_SEEDS` sets how many seeds to run (200 by
   default).
2. **Concurrent takeover.** The old writer keeps appending while a new lease
   acquires, on a single-threaded runtime whose store yields a seeded number of
   times per request, so every seed is a different (and reproducible)
   interleaving. Every append the old writer saw succeed must be in the new
   lease's disk. Removing the check after an append fails it on seed 1.
3. **Failpoints at every barrier.** A crash after each journal write, pack
   upload, page upload, manifest upload and head move, then recovery and a
   consistency check.
4. **Real ext4.** Mount, write, kill `blockd` with `kill -9`, remount on another
   machine, run `fsck`, and check that files that were `fsync`ed survive.
5. **Fencing.** Two machines attach one session. The older one's next FLUSH
   must fail, and nothing it writes afterward may become visible.

## What we measure before going further

| Question | Why it matters |
|---|---|
| `fsync` latency on R2, and on the Durable Object journal | Decided: the Durable Object (below) |
| Open-end fold latency | Decides whether the fold moves after the `open` returns |
| Extent size: 256 KiB today, ZeroFS uses 32 KiB, Lambda 512 KiB | Read amplification against request count |
| Pack fragmentation after a week of forks and undos | Decides whether repacking is worth building |
| Bytes written twice: once to the journal, again in the snapshot | ZeroFS avoids it by making its segments the data; we could let a snapshot point into the journal |
| Prefetch hit rate on a real repo's `pnpm install` | Decides whether attach prefetch pays |

**First numbers** (20 October 2026, `measure_sync_and_snapshot_latency` from
a laptop in California to R2, so every request pays a long round trip): an
`fsync` of 1, 64 or 1024 blocks takes about 440 ms at the median, flat in its
size, because it's one PUT plus one read of the head. A snapshot of four
extents takes about 1.4 s, which is four round trips in sequence (pack, pages,
manifest, head) plus deleting the folded journal. Both are bounded by request
latency, not bytes.

**Inside a Cloudflare container** (`test/Sandbox/Workspace.test.ts`: a 4 KiB
write and `fsync` through kernel ext4 on the loop device, 20 times):

| Journal | p50 | p90 |
|---|---|---|
| R2 entries, head checked through the Session Durable Object | 387 ms | 607 ms |
| The Session Durable Object (append and fence in one request) | 113 ms | 121 ms |

On a Lambda MicroVM in us-west-2 (`test/Sandbox/WorkspaceLambda.test.ts`):

| Journal | p50 | p90 |
|---|---|---|
| R2 entries and head, over S3 from AWS | 753 ms | 1091 ms |
| The Session Durable Object, through the host Worker's URL | 133 ms | 153 ms |

One ext4 `fsync` is two or three device flushes in sequence (the data, then
the journal commit with FUA), so 113 ms is about three trips from the
container through its machine's Durable Object to the session's. Halving it
means fewer trips per `fsync` (answering FUA writes and the flush after them
with one append) or a shorter path (the machine's object holding the journal,
with the session only fencing).

## On Cloudflare

`Cloudflare.Containers.Workspace(Workspace, { dockerfile, path, size, machine })`
deploys:

- **The volume**: an R2 bucket, a scoped token, and the base: `path` of the
  image `dockerfile` builds, imported at deploy.
- **A host Worker** of its own, with two Durable Object classes:
  - **Session**, one per session: the head (above), the journal, and the
    leases of the `open`s running on it. Overlapping opens with the same grant
    share one mount; an open with a different grant waits for the session to
    go idle. Leases expire unless the open renews them, so a caller that dies
    can't hold a session forever (an alarm reclaims them).
  - **Machine**, one per session, so its cache stays warm: a container built
    from `dockerfile` plus `blockd`, running `blockd mount --heads … --journal …`
    against `http://workspace.alchemy.internal`, a host the container's own
    Durable Object answers (a container control), which forwards to the session.
- **Bindings** in every Worker or Durable Object that yields the workspace, to
  both classes in the host's script.

With `machine.lambda`, machines are AWS Lambda MicroVMs instead (a
`Sandbox.Sandbox` hosted by `AWS.Lambda.MicrovmSandbox`, with the OS
capabilities to mount); sessions stay on Cloudflare. A MicroVM has no
container control, so its `blockd` reaches the session's head and journal
through the host Worker's own URL, presenting a secret only the host Worker
and its machines hold; its Durable Object stops it once it's been idle.

An `open` acquires a lease (mounting if the session is idle), runs its effect
with `exec`, `spawn` and `port` going straight to the machine, and releases
the lease; the last release unmounts, which snapshots. Egress on an `open` is
minted by the caller with its own gateway clients and handed to the machine,
which answers the container's relay with those grants (renewed with the
lease): the host Worker holds no gateway of its own. At the end of an `open`,
`blockd` kills whatever still uses the mount, so a server a command left
running can't hold the disk open.

## Sources

- **SlateDB** ([repo](https://github.com/slatedb/slatedb), Apache-2.0): writer
  epochs and fencing (RFC 0001), checkpoints and shallow clones (RFC 0004),
  durability levels and group commit (RFC 0008), a separate WAL store
  (RFC 0009), GC boundaries (RFC 0026).
- **ZeroFS** ([repo](https://github.com/Barre/ZeroFS), AGPL-3.0, read for its
  design only): data out of the metadata store, barrier ordering, epoch in
  object keys, verified `fsync`, prefix recovery, live-byte repacking,
  deterministic simulation and failpoint crash tests.
- **Archil**: machines attached per call, and fast `fsync` from a stateful tier.
- **LayerFS** ([repo](https://github.com/Ephemeral-AI-Lab/layerfs)): the
  workspace model of mount, run, commit, unmount, over a shared history.
- **Neon**: branches as pointers into history, a durable log materialized into
  images later, and GC that respects branch points.
- **AWS Lambda container loading**: content-addressed chunks shared across
  images, and tiered caches.
- **Modal**: block-level copy-on-write for VM disks, because FUSE metadata is
  slow inside VMs.
- **EBS**: incremental block snapshots with lazy restore.
