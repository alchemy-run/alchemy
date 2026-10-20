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
sessions/{id}/journal/{epoch}/{seq}  dirty blocks since the last snapshot
```

A head is the only mutable thing: session id → (manifest, epoch, journal
position). Heads live in the Session Durable Object, which is strongly
consistent. That's an advantage SlateDB and ZeroFS don't have: they build
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
the Session Durable Object grants a lease with a new **epoch**, one more than
the last. The epoch is in every journal key, and the Durable Object refuses
any head move or journal mark from an older epoch.

That's SlateDB's writer epoch (RFC 0001), with the fence enforced by the
coordinator rather than by racing for the next WAL filename. Putting the epoch
in the object key comes from ZeroFS, whose segment keys are
`{shard}/{epoch}/{counter}`: two writers can never collide on a name, so a
zombie can't overwrite anything; it can only write objects that nothing will
ever point at.

A machine that loses its lease (it stalled, or the Durable Object handed the
session to another machine) must stop. Its next FLUSH fails with an I/O error,
the kernel's ext4 goes read-only, and the commands in that `open` fail. It
never acknowledges an `fsync` it can't make durable. ZeroFS calls this a
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
  an epoch, and a write is acknowledged only after every earlier entry is
  durable. Recovery replays the longest gap-free prefix, so it can't apply a
  later write while missing an earlier one. That's ZeroFS's ordering rule: the
  recovered state is a prefix of acknowledged writes, never a subset.
- **Block granularity.** The journal stores 4 KiB blocks, not whole extents,
  so a small write to a large file costs a small journal entry. Snapshots keep
  extent granularity; the fold reads the base extent and applies the blocks.
- **Each entry has a checksum.** A torn or truncated entry ends the prefix.
- **A pluggable store.** SlateDB lets the WAL live on a different, faster
  store than the data (RFC 0009), because WAL latency is what bounds
  `fsync`. We do the same: R2 or S3 by default, and a low-latency option (the
  Session Durable Object's own storage, S3 Express One Zone) for sessions that
  `fsync` a lot. This is our answer to Archil's sub-millisecond `fsync`, which
  comes from their replicated SSD tier: we don't run a server tier, but the
  journal can sit on the fastest durable store the host has.

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

Today it's mark and sweep from every head, sparing objects younger than a grace
period. That grace period is a guess that a commit finishes in time, and
SlateDB's GC-boundary RFC (0026) describes how such guesses fail: a writer that
stalls past the window gets its objects deleted underneath it. We replace the
guess with knowledge the Durable Object has.

- **The boundary is the oldest live lease.** Every object a lease writes is
  newer than the lease. Collection spares anything written after the oldest
  active lease began, with no wall-clock guess.
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
guarantees come from.

1. **Deterministic simulation.** The engine runs over an in-memory object
   store on virtual time, with seeded latency, lost responses (the write
   landed but the reply didn't) and a crash at a seeded point. After each crash,
   an oracle checks that the disk equals some prefix of the writes, no older
   than the last acknowledged `fsync`.
2. **Failpoints at every barrier.** A crash after each journal write, pack
   upload, page upload, manifest upload and head move, then recovery and a
   consistency check.
3. **Real ext4.** Mount, write, kill `blockd` with `kill -9`, remount on another
   machine, run `fsck`, and check that files that were `fsync`ed survive.
4. **Fencing.** Two machines attach one session. The older one's next FLUSH
   must fail, and nothing it writes afterward may become visible.

## What we measure before going further

| Question | Why it matters |
|---|---|
| `fsync` latency on R2, and on the Durable Object journal | Decides the default journal store |
| Open-end fold latency | Decides whether the fold moves after the `open` returns |
| Extent size: 256 KiB today, ZeroFS uses 32 KiB, Lambda 512 KiB | Read amplification against request count |
| Pack fragmentation after a week of forks and undos | Decides whether repacking is worth building |
| Prefetch hit rate on a real repo's `pnpm install` | Decides whether attach prefetch pays |

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
