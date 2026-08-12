# git-service — Final Design Document

**A Git hosting service on Cloudflare Workers + Durable Objects + R2, built as `packages/git` with Alchemy Effect-native Workers.**

Stance: **protocol-first minimalist core (Proposal A's skeleton) with Proposal B's product ergonomics and scale seams grafted on.** v1 is the smallest system that real `git` clients (git ≥ 1.6.6 through current) can clone, fetch, and push against, with transactional refs and a typed REST management plane. Every cut has a named upgrade seam. The architecture is the ripgit/chr33s-validated shape (Worker router → one DO per repo → SQLite refs/objects + R2 overflow), re-expressed in Effect with real transactions (`transactionSync`), typed errors, streaming responses, and auth from day one.

---

## 0. Resolved contradictions (A vs B)

Every place the two proposals disagreed, with the decision and the one-line reason:

| Topic | A said | B said | **Decision** | Why (one line) |
|---|---|---|---|---|
| Object bytes at rest | zlib rows in DO SQLite, >1 MiB → R2 | Pack-first: pushed packs verbatim to R2, DO holds index only | **A** (rows + R2 overflow; packs are v1.1) | Pack emission from pre-deflated rows is pure concatenation (zero CPU), ripgit-proven in 128 MB; B's two-pass R2-fixup ingest is the single riskiest subsystem and buys nothing until repos outgrow the 50 MiB push cap — the `location`/`pack_id` columns keep B's endgame reachable without a migration. |
| Where the protocol runs | Inside the Repo DO | Worker data plane, DO control plane | **A** (in the DO) | The bytes live in the DO's SQLite so they must transit it anyway; duration billing is ~$0.0001 per clone-minute (0.125 GB × 60 s × $12.50/M GB-s), and B's Worker-side streaming becomes the natural v1.1 fast path only once compacted packs live in R2. |
| Fetch protocol | v0 only | v2 primary + v0 fallback | **A** (v0 only) | Every client ≥1.6.6 falls back to v0 silently; v2 is a pure-additive choreography file over the same closure/pack code, so shipping it in v1 doubles conformance surface for zero client reach. |
| Push ingestion | Buffer ≤ 50 MiB, `RandomAccess` seam | Stream to R2 multipart + 2-pass fixups | **A** (buffer + cap) | Bounded, simple, ripgit-proven; the parser is written against a `RandomAccess` source so the R2-tee upgrade is one implementation swap, not a protocol change. |
| Served deltas / thin packs | Never (fat packs) | Thin REF_DELTA against have-closure | **A** (never) | Thin-pack/ofs-delta serving are protocol MAYs; fat fetches are a bandwidth tax, not a correctness issue, and delta emission is the classic source of corruption bugs. |
| Name authority | Singleton Registry DO | Per-namespace NamespaceDO | **A** (singleton) with B's shard seam | Control-plane traffic is tiny in v1 and a singleton gives global listing for free; `getByName("registry:" + owner)` sharding changes no RPC interface. |
| Concurrent pushes | Unaddressed (staging ids make it safe-ish) | SQL receive lease + 503 | **Graft B, simplified**: in-memory `Effect.Semaphore` in the DO | Two 50 MiB buffers ≈ the whole isolate heap; one DO instance means an in-memory gate suffices (eviction kills the connection anyway) — no lease table needed. Waiters block ≤ 30 s, then `503 Retry-After: 10`. |
| Connectivity check on push | new-oids exist only | Full referenced-object membership | **Graft B** (full check) | With everything in SQLite the membership check is cheap batched SQL, and it's the difference between "corrupt client" and "corrupt repo". |
| Commit graph shape | `commits` + `commit_parents` tables | Single row, concatenated parents, `gen`, `commit_time` | **A's normalized tables + B's `gen`/`commit_time` columns** | Normalized parents make the BFS a JOIN; generation numbers bound negotiation walks and cost nothing at ingest. |
| Oid encoding | TEXT 40-hex | BLOB 20-byte | **A** (TEXT hex) | zdata BLOBs dominate storage, so index bytes aren't the bottleneck; hex rows are debuggable and match the wire. |
| Fork | Vague (test-plan only) | Catalog-row sharing of parent's immutable R2 keys | **Graft B's sharing, adapted**: row snapshot copy + shared R2 keys via `objects.r2_key` | SQLite rows must be copied (no cross-DO sharing), but R2 objects are immutable and shared by full key; parent's R2 prefix is retained while `fork_count > 0`. |
| Import / fork / delete execution | Unspecified | Cloudflare Queue consumer jobs | **DO alarm jobs, no Queue** | Alarms have the same 15-min budget as queue consumers, reuse the DO-resident ingest code directly, and add zero infrastructure. |
| Async-op status surface | — | `jobs` table + jobs endpoints | **Neither**: `Repo.status` field + `RepoNotReady` error | Polling `GET /repos/:o/:r` for `status: importing\|forking\|deleting → ready\|404` needs no jobs API and no cross-DO status plumbing. |
| REST ref writes | Deferred to v2 | PUT/DELETE with CAS in v1 | **Graft B** (in v1) | They reuse the exact `transactionSync` CAS path receive-pack already needs — ~50 lines for a genuinely useful surface (CI tagging, release automation). |
| Repo create response | `Repo` | `RepoCreated` with bootstrap write token + remote URL | **Graft B** | Kills the create-then-mint round trip; the token machinery exists anyway. |
| `readOnly` repos | — | Repo flag, `ReadOnlyRepo` 403 | **Graft B** | One config row + one check in receive-pack and ref-write; Artifacts parity. |
| Token scopes | read/write/admin, names, optional TTL | read/write, mandatory TTL | **A** (three scopes, names, optional TTL) | Per-repo `admin` scope enables delegated token management without handing out the deployer key; mandatory TTL is policy, not mechanism — leave it to the caller. |
| Blob REST reads | base64 JSON ≤ 1 MiB + raw streaming route | Octet-stream HttpApi endpoint + `file` path endpoint | **A's split + B's `file` route** (as a raw route) | Raw routes keep binary streaming out of schema land (repo convention); the path-walk `file` read is cheap over existing tree primitives and highly useful. |
| Error tag namespacing | Plain tags (`RepoNotFound`) | Prefixed (`git-service/RepoNotFound`) | **A** (plain) | Shorter wire payloads, matches `HttpApiError` conventions; the API name already scopes the client. |
| Repo delete semantics | Sync NoContent | Async job id | **NoContent immediately, async purge via alarm** (`status: "deleting"` until gone) | R2 prefix deletion is a list+delete loop that can't run inline; the status field already carries the async story. |

---

## 1. Decisions up front (the opinionated core)

| Decision | Choice | Why |
|---|---|---|
| Protocol version | **v0 only** (upload-pack and receive-pack) | git ≥ 2.26 sends `Git-Protocol: version=2` but falls back cleanly when the server answers v0. ripgit ships v0-only and hosts 40k-commit repos. v2 is a pure-additive upgrade (§10). |
| Negotiation | multi_ack_detailed + no-done, "lazy-ready" | Converges in ≤ 2 POSTs, stateless, answered per-POST from SQLite. |
| Served packs | **No deltas, no thin packs.** Every entry = varint header + stored zlib bytes, concatenated | Legal (thin-pack/ofs-delta are MAYs); zero-CPU pack emission because objects are stored as `zlib(content)` — pack generation is literally concatenation + SHA-1. |
| Push ingestion | Full thin-pack + ofs/ref-delta support, **pack body buffered, hard cap 50 MiB**, one push at a time per repo | Thin packs on push are non-optional (git always sends them over HTTP). Buffering with a cap is the ripgit-proven memory budget; the streaming-to-R2 upgrade is a contained change (§3.6). |
| Where the protocol runs | **Inside the Repo DO** (Worker authenticates + proxies) | The DO owns refs and all loose object bytes; single-threading + input/output gates make ref CAS trivially serializable. Duration billing is a non-issue (§0). |
| Object storage | zlib-compressed rows in DO SQLite; objects > 1 MiB compressed → R2; pack compaction to R2 is **v1.1**, schema-ready | Simplest storage that is actually transactional. The 2 MB SQLite row cap forces the R2 split; the `location` column makes compaction additive. |
| Refs | DO SQLite, CAS inside `transactionSync` | The single strongest reason this architecture works. R2 is disqualified (1 write/s/key, last-writer-wins). |
| Hashing | SHA-1 only (`object-format=sha1`) | sha256 repos are rare; oid schemas are branded so widening later is mechanical. |
| Repos | All private in v1. Anonymous = 401. `readOnly` flag rejects writes with a typed 403 | Cuts the visibility model; auth is one code path. |
| Shallow | `shallow` + `deepen <n>` (depth only) in v1 | Without it `actions/checkout` (depth=1 default) fails hard. Bounded BFS + boundary lines — cheap. `deepen-since`/`deepen-not` cut. |
| Fork / import / delete | Async DO-alarm jobs; status via `Repo.status`; forks share parent R2 keys | Reuses DO-resident ingest and purge code; zero new infrastructure; R2 immutability makes sharing safe. |
| Free Workers plan | Unsupported | 10 ms CPU cannot inflate a pack. `GitWorker` sets `limits.cpu_ms = 300_000`. |

---

## 2. Architecture

### 2.1 Components

```
                    ┌────────────────────────────────────────────────┐
 git CLI / REST     │  GitWorker (stateless, Effect-native Worker)   │
 client             │  • routes /api/v1/** → Effect HttpApi          │
   ──────────────►  │  • routes /:owner/:repo.git/** → git protocol  │
                    │  • parses Basic/Bearer creds (never verifies   │
                    │    repo tokens itself — the Repo DO does)      │
                    │  • verifies the admin key (timingSafeEqual)    │
                    │  • Registry lookups (owner/name → repoId),     │
                    │    60 s in-isolate LRU cache                   │
                    └───────┬──────────────────────────┬─────────────┘
                            │ typed RPC / stub.fetch   │ typed RPC
                            ▼                          ▼
        ┌──────────────────────────────┐   ┌────────────────────────┐
        │  Repo DO (one per repo,      │   │  Registry DO           │
        │  getByName(repoId))          │   │  (singleton,           │
        │  owns: refs, objects index,  │   │  getByName("registry"))│
        │  loose object bytes, tokens, │   │  owns: owner/name →    │
        │  commit graph, push staging, │   │  repoId map, listing,  │
        │  alarm jobs (import/fork/    │   │  uniqueness, fork      │
        │  delete-purge/GC)            │   │  lineage + counts      │
        │  runs: advertise, upload-    │   └────────────────────────┘
        │  pack, receive-pack          │
        └──────────┬───────────────────┘
                   │ R2 binding (inside the DO for oversize reads/writes)
                   ▼
        ┌──────────────────────────────┐
        │  R2 bucket "git-objects"     │
        │  {repoId}/objects/{oid}      │  oversize loose objects (immutable)
        │  {repoId}/packs/pack-*.pack  │  v1.1 compaction output (immutable)
        └──────────────────────────────┘
```

**Why one DO per repo (not a namespace DO holding many):** per-repo write serialization for free (ref CAS needs no locks), per-repo isolation of the 10 GB SQLite ceiling, horizontal scale by construction. The DO id is `idFromName(repoId)` where `repoId` is a ULID minted at creation — **not** `owner/name` — so renames never move data and a deleted-then-recreated `owner/name` gets a fresh DO (no zombie state).

**Why a singleton Registry DO:** repo CRUD needs a uniqueness authority, a listing surface, and a fork-lineage ledger. It's low-rate control-plane traffic. Upgrade seam: shard by owner via `getByName("registry:" + owner)` — the RPC interface doesn't change; global listing then requires fan-out or is cut. The Worker caches `owner/name → repoId` per-isolate for 60 s; the Repo DO stores its own `(owner, name)` and rejects mismatched requests, so a stale cache entry fails safe and triggers re-resolve.

**Why the git protocol runs in the DO, not the Worker:** every byte the protocol needs (refs, object rows, commit graph, tokens) lives in the DO's SQLite. Running upload/receive-pack in the Worker would mean chatty RPC choreography for thin-base lookups, staging batches, and manifest paging. Inside the DO it's direct synchronous SQL. Long pushes don't starve reads: workerd interleaves other events at non-storage `await` points (client body reads, R2 calls), and the ref CAS at the end is a single `transactionSync`. The one inherited rule: **re-verify nothing across an `await` — all ref reads/writes happen inside the final `transactionSync`.**

**Push serialization:** the Repo DO's runtime closure holds an `Effect.Semaphore(1)` guarding receive-pack ingest (two concurrent 50 MiB buffers would exhaust the 128 MB isolate). A second push waits up to 30 s for the permit, then gets `503` + `Retry-After: 10` (git retries cleanly). In-memory is sufficient: there is exactly one live instance per DO, and an eviction mid-push kills the holder's connection anyway.

### 2.2 URL space

```
/api/v1/**                              REST (Effect HttpApi)
/api/v1/repos/:o/:r/blobs/:oid/raw      raw blob bytes (raw route, streaming)
/api/v1/repos/:o/:r/file?ref&path       file-at-path bytes (raw route, streaming)
/:owner/:repo[.git]/info/refs           smart-HTTP ref advertisement
/:owner/:repo[.git]/git-upload-pack     fetch/clone
/:owner/:repo[.git]/git-receive-pack    push
```

`api` is a reserved owner name (Registry rejects it at creation). The Worker's `fetch` is the canonical `StateStore/Api.ts` composition: `HttpApiBuilder.layer(GitApi)` + handler layers + `Layer.merge(rawGitRoutes)` (raw routes registered on the same `HttpRouter`) + `[Etag.layer, HttpPlatformStub, Path.layer]` + `HttpRouter.toHttpEffect` (§5, §6).

### 2.3 Request flows

**Clone (fresh):**
1. `GET /:o/:r.git/info/refs?service=git-upload-pack` → Worker parses Basic creds, Registry lookup (cached) → `repos.getByName(repoId).fetch(request)` → DO verifies token (read scope), rejects with `RepoNotReady` semantics (503) while `status != ready`, then emits the v0 advertisement: `# service=` prelude, flush, `HEAD` first with capability line (`multi_ack_detailed no-done side-band-64k shallow ofs-delta agent=git-service/1 symref=HEAD:refs/heads/<default> object-format=sha1`), refs sorted, annotated tags peeled (`^{}` lines), flush. `Cache-Control: no-cache`. Empty repo: zero-id `capabilities^{}` line.
2. `POST git-upload-pack` — body is `want`s + flush + `done` (no haves). DO gunzips if `Content-Encoding: gzip` (`DecompressionStream("gzip")`; sniff `1f 8b` defensively), parses pkt-lines, computes the full closure (§3.5), replies `NAK` then the pack on sideband band 1 (65515-byte frames), progress on band 2, flush. If the client did **not** negotiate `side-band-64k`, the pack is sent raw after the ACK/NAK section. The response body is a `Stream<Uint8Array>` — `HttpServerResponse.stream(...)`, chunked, flushed as written; the Worker proxies the `HttpServerResponse` from `stub.fetch` untouched.

**Incremental fetch:** same, but the POST carries `have`s. Round 1 (ends in flush): DO `ACK <oid> common` for each have that exists in `objects`, `ACK <oid> ready` once the want-closure is coverable, else `NAK`. With `no-done` the DO may continue straight into the pack after `ready`. Round 2 (ends in `done`): final `ACK`/`NAK` + pack. Closure = commits BFS from wants stopping at ACKed haves (generation numbers bound the walk), plus those commits' full tree/blob closure with an in-walk visited set (§3.5 — the accepted v1 fat: ~one snapshot's worth of redundancy at the boundary; harmless to clients).

**Shallow clone (`--depth N`):** wants + `deepen N`. DO does a depth-bounded BFS, emits `shallow <oid>` boundary lines (and `unshallow` for previously-shallow client tips now complete), flush, then ACK/NAK + depth-truncated pack. Client `shallow` lines on later fetches are treated as additional walk boundaries.

**Push:**
1. `GET info/refs?service=git-receive-pack` → v0 advertisement with `report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta object-format=sha1 agent=git-service/1`.
2. `POST git-receive-pack` → DO: acquire the push semaphore; parse command pkt-lines (`old new refname\0caps` on the first); handle the **empty-flush probe** (git sends a bare `0000` POST when the payload exceeds `http.postBuffer`; reply empty 200 so it retries with the real body). Reject writes to `readOnly` repos with `ng` per ref. Buffer the raw pack (reject > 50 MiB with `unpack pack exceeds 50 MiB limit` + per-ref `ng` — a clean in-band report, not an HTTP error). Ingest (§3.6): index → resolve deltas (thin bases from own store) → hash → stage → **connectivity check** (every oid referenced by staged commits/trees is in staged ∪ live objects; batched SQL). Then one `transactionSync`: CAS every command's old-oid against `refs`, honor `atomic` (all-or-nothing) vs per-ref, flip staged objects live, insert commit-graph rows, update `default_branch` on first branch push. Reply `report-status` (`unpack ok` / `ok|ng <ref>`) **wrapped in sideband band 1** when the client negotiated side-band (unmuxed report while sideband is active breaks the client). `report-status-v2` is advertised and implemented identically (no `option` lines — valid).
3. Post-commit, `state.waitUntil`: GC bookkeeping, compaction-threshold check (v1.1 alarm).

**Fork:** `POST /repos/:o/:r/fork` → Registry CAS-inserts the target row (`status: "forking"`, `fork_of`, bump parent `fork_count`) → new Repo DO initializes and arms an immediate alarm → alarm job streams a row snapshot from the parent DO over an RPC `Stream` (refs, objects metadata **including `zdata` for `location='row'` rows**, commits, config) and copies it in batches; `location='r2'` rows are copied **by reference** — the `r2_key` column carries the parent's full key (immutable, shared) → `status: "ready"`. Documented v1 limit: fork cost is O(parent row bytes); v1.1 compaction (bytes in shared R2 packs) makes forks near-O(index).

**Import:** `POST /repos/import` → Registry inserts (`status: "importing"`) → Repo DO alarm job acts as a git v0/v2 HTTP client against the source URL (depth-limited fetch), ingests through the same `PackParser` path with the same 50 MiB cap (documented v1 limit: small/depth-limited imports only), sets refs, `status: "ready"`; failures set `status` back plus an error detail readable on the Repo resource.

**Delete:** `DELETE /repos/:o/:r` → Registry marks `deleted_at` (name freed for reuse only after purge), Repo `status: "deleting"` → NoContent immediately → alarm job purges: R2 prefix list+delete loop (bounded per alarm run, re-armed until done) — **but the R2 prefix is retained while Registry reports `fork_count > 0`** (forks reference those keys); SQLite dropped via `deleteAll`; Registry row removed last. Purge is idempotent and alarm-retried.

**REST call:** `POST /api/v1/repos/:o/:r/tokens` → HttpApi middleware parses credentials into a `Credentials` service → handler calls `repos.getByName(repoId).createToken(credentials, {...})` → DO enforces scope and returns; tagged errors surface as typed HTTP statuses.

---

## 3. Storage design

### 3.1 Repo DO SQLite schema (exact DDL)

```sql
-- config: repoId, owner, name, default_branch, description, created_at,
--         schema_version, status ('ready'|'importing'|'forking'|'deleting'),
--         read_only ('0'|'1'), fork_of (parent repoId or absent)
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- all refs, full names. HEAD is virtual: symref to config.default_branch.
CREATE TABLE IF NOT EXISTS refs (
  name TEXT PRIMARY KEY,          -- 'refs/heads/main', 'refs/tags/v1'
  oid  TEXT NOT NULL              -- 40-hex sha1
) WITHOUT ROWID;

-- object index + loose bytes. zdata is zlib(content) WITHOUT the loose header,
-- so pack emission is: varint(type,size) + zdata, verbatim.
CREATE TABLE IF NOT EXISTS objects (
  oid         TEXT PRIMARY KEY,   -- 40-hex
  type        INTEGER NOT NULL,   -- 1=commit 2=tree 3=blob 4=tag
  size        INTEGER NOT NULL,   -- uncompressed bytes
  zsize       INTEGER NOT NULL,   -- stored/compressed bytes
  location    TEXT NOT NULL DEFAULT 'row',  -- 'row' | 'r2' | 'pack' (pack = v1.1)
  zdata       BLOB,               -- NULL when location != 'row'
  r2_key      TEXT,               -- full R2 key when location='r2'; may point at a
                                  -- FORK PARENT's prefix (immutable, shared)
  pack_id     TEXT,               -- v1.1: packs/pack-<sha>.pack
  pack_offset INTEGER,            -- v1.1: byte offset of zdata within pack
  staged_push TEXT                -- NULL = live; else the push_id that staged it
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_objects_staged ON objects(staged_push) WHERE staged_push IS NOT NULL;

-- commit graph for closure/negotiation walks (populated at ingest)
CREATE TABLE IF NOT EXISTS commits (
  oid         TEXT PRIMARY KEY,
  tree        TEXT NOT NULL,
  gen         INTEGER NOT NULL,   -- generation number: max(parent gen) + 1; roots = 1
  commit_time INTEGER NOT NULL    -- committer timestamp (seam: deepen-since)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commit_parents (
  oid    TEXT NOT NULL,
  parent TEXT NOT NULL,
  ord    INTEGER NOT NULL,
  PRIMARY KEY (oid, parent)
) WITHOUT ROWID;

-- per-repo access tokens (§8)
CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,        -- ULID
  token_hash   TEXT NOT NULL UNIQUE,    -- hex(sha256(token))
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,           -- 'read' | 'write' | 'admin'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                 -- NULL = no expiry
  last_used_at INTEGER
) WITHOUT ROWID;

-- crash-safety bookkeeping for pushes (GC'd by alarm)
CREATE TABLE IF NOT EXISTS pushes (
  push_id    TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state      TEXT NOT NULL              -- 'staging' | 'committed'
) WITHOUT ROWID;

-- async job bookkeeping (import/fork/delete-purge progress; single row per kind)
CREATE TABLE IF NOT EXISTS jobs (
  kind       TEXT PRIMARY KEY,          -- 'import' | 'fork' | 'purge' | 'gc'
  state      TEXT NOT NULL,             -- 'running' | 'failed'
  detail     TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

Registry DO:

```sql
CREATE TABLE IF NOT EXISTS repos (
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  repo_id     TEXT NOT NULL UNIQUE,     -- ULID
  description TEXT,
  fork_of     TEXT,                     -- parent repo_id, NULL if not a fork
  fork_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER,                  -- soft-delete marker during purge
  PRIMARY KEY (owner, name)
) WITHOUT ROWID;
```

Schema init runs in the DO's outer init effect under `blockConcurrencyWhile` semantics (idempotent `CREATE TABLE IF NOT EXISTS`), with a `schema_version` config row for future migrations. Note the platform gotcha: DO RPC methods must not be named `delete` (Cloudflare stub proxy reserves it) — use `remove`/`purge`.

### 3.2 R2 key scheme

```
{repoId}/objects/{oid}            zlib(content), immutable, written once
{repoId}/packs/pack-{sha1}.pack   v1.1 compaction output, immutable
```

All R2 keys are **immutable and content-addressed** — this sidesteps the 1-write/s/key limit, makes conditional-put re-runs (idempotent alarm jobs) safe, and makes **cross-repo fork references safe** (a fork's `objects.r2_key` may point into the parent's prefix). R2 `list()` is never used on a hot path (Class A, $4.50/M); the `objects` table is the sole inventory. List is used only in delete-purge and GC reconciliation.

### 3.3 Loose vs. R2 thresholds and the promotion story

- **`location='row'`**: compressed size ≤ **1 MiB** (safety margin under the 2 MB SQLite row cap). This is where every normal object lives in v1. Read cost: DO rows at $0.001/M, synchronous, no 6-connection cap — 360× cheaper and far faster than per-object R2 GETs.
- **`location='r2'`**: compressed size > 1 MiB → written to `{repoId}/objects/{oid}` at ingest (single streaming `put`), row records metadata + `r2_key`.
- **Per-object cap (v1): 64 MiB uncompressed.** Delta application needs base + result in memory; this cap keeps worst-case ingest memory bounded. Rejected with `unpack object too large` + `ng`.
- **Promotion/compaction (v1.1, schema-ready, not in v1):** an alarm fires when `SUM(zsize) WHERE location='row'` > **1 GB** or live loose count > **50 000**. The handler streams a no-delta pack of the oldest N objects to R2 via multipart (5 MiB uniform parts), then in one `transactionSync` flips those rows to `location='pack'` with `pack_id`/`pack_offset` and NULLs `zdata`. Because pack entries are `varint header + zlib(content)` and we store `zlib(content)`, the "pack" is a concatenation — and `pack_offset` points at the zdata span, so fetch does **ranged R2 reads** per object, or (B's fast path, adopted as the v1.1 clone path) streams whole entry-regions verbatim for full clones. Idempotent (content-addressed pack key + conditional put), alarm-retried, 15-min budget respected by capping objects per run. Nothing in the fetch path changes shape: the emitter already dispatches on `location`.

This ordering (row → r2/pack) is forced by the platform numbers: DO storage $0.20/GB-mo vs R2 $0.015 (13×) makes R2 the long-term home; DO rows' read economics make them the right hot tier; the 2 MB row cap draws the line.

### 3.4 Transactionality of ref updates

All ref mutations — push commands, REST ref writes, fork/import finalization — go through one code path in the Repo DO:

```ts
// inside receive-pack finalize, single event, no awaits inside:
storage.transactionSync(() => {
  for (const cmd of commands) {
    const current = sql.exec("SELECT oid FROM refs WHERE name = ?", cmd.ref).one()?.oid ?? ZERO;
    if (current !== cmd.oldOid) { results.push(ng(cmd.ref, "fetch first")); if (atomic) throw new RefCasFailed(results); continue; }
    // delete / insert / update refs row
  }
  sql.exec("UPDATE objects SET staged_push = NULL WHERE staged_push = ?", pushId);
  // insert commits / commit_parents rows for staged commits
  sql.exec("UPDATE pushes SET state = 'committed' WHERE push_id = ?", pushId);
});
```

The DO's input/output gates guarantee no interleaving between statements; `transactionSync` guarantees atomicity against mid-event failure. The client's `old-oid` is the compare-and-swap token (this also makes force-push semantics correct without locking). REST `PUT/DELETE` ref endpoints run the same block with a single synthetic command (`expectedOid` → old-oid; absent `expectedOid` = unconditional). Crash before the transaction ⇒ staged rows with a dangling `push_id`; a daily alarm deletes `pushes` rows in `staging` older than 24 h and their staged objects (R2 orphans under `objects/` are harmless — content-addressed — and re-pushed identical objects hit the same key).

### 3.5 Fetch closure computation and pack assembly within 128 MB

**Closure:** BFS from wants over `commit_parents` (in-DO SQL, chunked `IN` lists ≤ 100 params), stopping at haves that exist in `objects`, bounded below by generation numbers (never walk past `min(gen(haves))` unnecessarily), and at the depth bound when `deepen` is present. Then walk each frontier commit's tree: read tree rows, parse entries, recurse, with an in-memory visited `Set<string>` shared across the whole walk. Memory: 500 k oids ≈ 25 MB of Set — cap manifest at 1 M objects for v1 (larger repos are a documented v1 limit; the v1.1 fix is whole-pack streaming from R2 for clones).

**Emission (all streaming, constant memory):**

```
PACK + version(2) + count(manifest.length)          — count known before streaming: manifest is materialized first
for each oid in manifest (batched row reads, ≤100/query, ~8 MiB adaptive zsize budget):
    emit varint(type, size) + zdata                  — 'row': the BLOB; 'r2': R2 get body; 'pack' (v1.1): R2 ranged get
    sha1.update(everything)                          — node:crypto createHash, incremental
emit sha1 trailer
```

Wrapped in a sideband-band-1 framing transform (≤ 65515-byte payloads) when negotiated, returned as `HttpServerResponse.stream`. No compression CPU at all — bytes are stored pre-deflated. Progress lines (`Counting objects...`) on band 2 every N objects.

### 3.6 Push ingest within 128 MB

Single pass over the buffered pack (≤ 50 MiB), under the push semaphore:

1. Validate `PACK`, version 2, count.
2. Per entry: parse type/size varint. Non-delta: `zlib.createInflate()`, feed the tail; on `end`, `bytesWritten` = exact compressed span (workerd-verified). Hash `sha1("<type> <size>\0" + content)`. **Store the compressed span verbatim as `zdata`** — no recompression. Deltas (OFS with the +1-bias offset decoding, REF with 20-byte base id): resolve base from (a) already-ingested entries via a bounded LRU of resolved contents (20 MiB, shared buffers), (b) re-inflation from the pack buffer on cache miss, or (c) **the object store for thin bases** (REF_DELTA to a prior push — the normal case). Apply the copy/insert instruction stream (`size==0 ⇒ 0x10000` special case), verify `result_size`, hash, `deflateSync` (level 6), store.
3. Verify the trailing pack SHA-1; mismatch ⇒ `unpack pack checksum mismatch` + all-`ng`.
4. Rows inserted with `staged_push = pushId` as resolved (objects > 1 MiB compressed go to R2 first, then the row). Existing oids skipped (idempotent re-push).
5. **Connectivity check (full):** collect every oid referenced by staged commits (tree, parents) and staged trees (entries), and every command's `new-oid`; batched `SELECT` membership against staged ∪ live objects (chunked `IN` ≤ 100). Any miss ⇒ `unpack missing objects` + all-`ng`. Cheap SQL; prevents a buggy/malicious client from corrupting the repo.
6. Compute `gen`/`commit_time` for staged commits (parents are all present per step 5).

Budget: 50 MiB pack + 20 MiB cache + ≤ 64 MiB single-object worst case is theoretical-max-tight; in practice large objects aren't delta'd against large bases, and ripgit ships this exact profile in 128 MB. The semaphore guarantees one ingest at a time. The pack size cap is enforced *before* buffering via `Content-Length` when present and by counting during body read otherwise.

**Upgrade seam (v1.x, when the 50 MiB cap hurts):** tee the incoming body to R2 multipart (`{repoId}/incoming/{pushId}.pack`) while indexing in the same pass; delta re-resolution then uses R2 ranged reads instead of the memory buffer. The parser is written against a `RandomAccess` abstraction (`PackParser.ingest(source: RandomAccess)`) from day one so this swap touches one implementation, not the protocol code.

---

## 4. Git protocol scope for v1

### Supported (exact)

| Area | v1 support |
|---|---|
| Transport | Smart HTTP only. `info/refs` advertisement with `# service=` prelude for both services; `Cache-Control: no-cache`; 401 + `WWW-Authenticate: Basic realm="git-service"`; gzip request bodies decompressed (`DecompressionStream("gzip")` + `1f 8b` sniff); streamed chunked responses; `ERR` pkt / band-3 for in-band fatals; 503 + `Retry-After` on push contention. |
| upload-pack (fetch/clone) | **Protocol v0.** Capabilities: `multi_ack_detailed`, `no-done`, `side-band-64k`, `shallow` (+ `deepen <n>` only), `agent`, `symref=HEAD:...`, `object-format=sha1`. Peeled `^{}` lines for annotated tags. Negotiation: ack `common` for known haves, `ready` when coverable, else `NAK`; ≤ 2 rounds. Empty-repo advertisement (`capabilities^{}`). Non-sideband clients get the raw pack. |
| receive-pack (push) | Protocol v0 (push has no v2). Capabilities: `report-status`, `report-status-v2`, `delete-refs`, `side-band-64k`, `atomic`, `ofs-delta`, `object-format=sha1`, `agent`. Create/update/delete refs, old-oid CAS, force push (unpoliced in v1), thin-pack + ofs/ref-delta ingestion, full connectivity check, empty-flush probe handling, report inside band 1, one-push-at-a-time serialization. |
| Objects | commit, tree, blob, **tag (annotated tags stored and served — not dropped)**. Byte-verbatim round-tripping (we never re-serialize; hashes, gpgsig, timezones survive — automatic, since stored bytes are the received bytes). |

The cut list with upgrade paths is consolidated in §10.

---

## 5. The Effect HttpApi REST surface

Contract lives in `src/Api.ts`, following `packages/alchemy/src/Cloudflare/StateStore/Api.ts` / `State/HttpStateApi.ts` conventions (effect `4.0.0-beta.105`, `effect/unstable/httpapi`). Abbreviated only where repetitive:

```ts
import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

// ── primitives ────────────────────────────────────────────────────────────
export const Oid = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/), Schema.brand("Oid"));
export const RepoName = Schema.String.pipe(Schema.pattern(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i));
export const OwnerName = RepoName;
export const RefName = Schema.String.pipe(Schema.pattern(/^refs\/[^\s~^:?*\[\\]+$/));
export const TokenScope = Schema.Literals(["read", "write", "admin"]);
export const RepoStatus = Schema.Literals(["ready", "importing", "forking", "deleting"]);

// ── error taxonomy (tagged, status-annotated) ─────────────────────────────
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()("Unauthorized",
  {}, HttpApiSchema.annotations({ status: 401 })) {}
export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()("Forbidden",
  { required: TokenScope }, HttpApiSchema.annotations({ status: 403 })) {}
export class ReadOnlyRepo extends Schema.TaggedErrorClass<ReadOnlyRepo>()("ReadOnlyRepo",
  {}, HttpApiSchema.annotations({ status: 403 })) {}
export class RepoNotFound extends Schema.TaggedErrorClass<RepoNotFound>()("RepoNotFound",
  { owner: Schema.String, repo: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class RepoAlreadyExists extends Schema.TaggedErrorClass<RepoAlreadyExists>()("RepoAlreadyExists",
  { owner: Schema.String, repo: Schema.String }, HttpApiSchema.annotations({ status: 409 })) {}
export class RepoNotReady extends Schema.TaggedErrorClass<RepoNotReady>()("RepoNotReady",
  { status: RepoStatus }, HttpApiSchema.annotations({ status: 409 })) {}
export class RefNotFound extends Schema.TaggedErrorClass<RefNotFound>()("RefNotFound",
  { ref: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class RefConflict extends Schema.TaggedErrorClass<RefConflict>()("RefConflict",
  { ref: Schema.String, currentOid: Schema.NullOr(Oid) }, HttpApiSchema.annotations({ status: 409 })) {}
export class ObjectNotFound extends Schema.TaggedErrorClass<ObjectNotFound>()("ObjectNotFound",
  { oid: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class WrongObjectType extends Schema.TaggedErrorClass<WrongObjectType>()("WrongObjectType",
  { oid: Schema.String, expected: Schema.String, actual: Schema.String },
  HttpApiSchema.annotations({ status: 422 })) {}
export class ObjectTooLarge extends Schema.TaggedErrorClass<ObjectTooLarge>()("ObjectTooLarge",
  { oid: Schema.String, size: Schema.Number }, HttpApiSchema.annotations({ status: 422 })) {}
export class TokenNotFound extends Schema.TaggedErrorClass<TokenNotFound>()("TokenNotFound",
  { id: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class ImportFailed extends Schema.TaggedErrorClass<ImportFailed>()("ImportFailed",
  { reason: Schema.String }, HttpApiSchema.annotations({ status: 502 })) {}
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError",
  { message: Schema.String }, HttpApiSchema.annotations({ status: 400 })) {}

// ── auth middleware ───────────────────────────────────────────────────────
// Parses Basic (git CLI: password = token) or Bearer into a Credentials service.
// Enforcement happens in the Repo DO, which owns the tokens table (§8).
export class Credentials extends Context.Service<Credentials, {
  readonly token: Redacted.Redacted<string>;      // repo token or admin key
}>()("git-service/Credentials") {}

export class GitAuth extends HttpApiMiddleware.Service<GitAuth, { provides: Credentials }>()(
  "git-service/GitAuth",
  { security: { bearer: HttpApiSecurity.bearer, basic: HttpApiSecurity.basic },
    error: Unauthorized },
) {}

// ── domain shapes ─────────────────────────────────────────────────────────
export class Repo extends Schema.Class<Repo>("Repo")({
  owner: OwnerName, name: RepoName, repoId: Schema.String,
  defaultBranch: Schema.String, description: Schema.NullOr(Schema.String),
  readOnly: Schema.Boolean,
  forkOf: Schema.NullOr(Schema.String),            // parent repoId
  status: RepoStatus,                              // poll this for async fork/import/delete
  createdAt: Schema.Number,
}) {}
export class Ref extends Schema.Class<Ref>("Ref")({
  name: RefName, oid: Oid, peeled: Schema.optional(Oid),
}) {}
const Signature = Schema.Struct({
  name: Schema.String, email: Schema.String, date: Schema.Number, tz: Schema.String });
export class CommitInfo extends Schema.Class<CommitInfo>("CommitInfo")({
  oid: Oid, tree: Oid, parents: Schema.Array(Oid),
  author: Signature, committer: Signature, message: Schema.String,
}) {}
export class TreeEntry extends Schema.Class<TreeEntry>("TreeEntry")({
  mode: Schema.String, name: Schema.String, oid: Oid,
  type: Schema.Literals(["blob", "tree", "commit"]),   // commit = gitlink
}) {}
export class TokenInfo extends Schema.Class<TokenInfo>("TokenInfo")({
  id: Schema.String, name: Schema.String, scope: TokenScope,
  createdAt: Schema.Number, expiresAt: Schema.NullOr(Schema.Number),
  lastUsedAt: Schema.NullOr(Schema.Number),
}) {}
export class CreatedToken extends TokenInfo.extend<CreatedToken>("CreatedToken")({
  token: Schema.String,                                 // shown exactly once
}) {}
export class RepoCreated extends Schema.Class<RepoCreated>("RepoCreated")({
  repo: Repo,
  remote: Schema.String,                                // https clone URL
  token: CreatedToken,                                  // bootstrap 'write' token, one round trip
}) {}
const Paginated = <A extends Schema.Top>(items: A) => Schema.Struct({
  items: Schema.Array(items), nextCursor: Schema.NullOr(Schema.String), hasMore: Schema.Boolean,
});

// ── groups ────────────────────────────────────────────────────────────────
const RepoPath = Schema.Struct({ owner: OwnerName, repo: RepoName });

const repos = HttpApiGroup.make("repos")
  .add(HttpApiEndpoint.post("create", "/repos", {
    payload: Schema.Struct({
      owner: OwnerName, name: RepoName,
      defaultBranch: Schema.optional(Schema.String),    // default "main"
      description: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Boolean),
    }),
    success: RepoCreated,
    error: [RepoAlreadyExists, ValidationError, Forbidden],
  }))
  .add(HttpApiEndpoint.get("get", "/repos/:owner/:repo", {
    params: RepoPath, success: Repo, error: RepoNotFound,
  }))
  .add(HttpApiEndpoint.patch("update", "/repos/:owner/:repo", {
    params: RepoPath,
    payload: Schema.Struct({
      description: Schema.optional(Schema.NullOr(Schema.String)),
      defaultBranch: Schema.optional(Schema.String),    // must resolve to an existing branch
      readOnly: Schema.optional(Schema.Boolean),
    }),
    success: Repo,
    error: [RepoNotFound, RefNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.get("list", "/repos", {
    query: Schema.Struct({
      owner: Schema.optional(OwnerName),
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))),
    }),
    success: Paginated(Repo),
  }))
  .add(HttpApiEndpoint.del("delete", "/repos/:owner/:repo", {
    params: RepoPath, success: HttpApiSchema.NoContent,   // async purge; status → 'deleting' → 404
    error: [RepoNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.post("fork", "/repos/:owner/:repo/fork", {
    params: RepoPath,
    payload: Schema.Struct({ targetOwner: OwnerName, targetName: RepoName }),
    success: RepoCreated,                                 // status: 'forking'; poll GET repo
    error: [RepoNotFound, RepoAlreadyExists, RepoNotReady, Forbidden],
  }))
  .add(HttpApiEndpoint.post("import", "/repos/import", {
    payload: Schema.Struct({
      owner: OwnerName, name: RepoName,
      source: Schema.Struct({
        url: Schema.String,
        ref: Schema.optional(Schema.String),
        depth: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
      }),
    }),
    success: RepoCreated,                                 // status: 'importing'; poll GET repo
    error: [RepoAlreadyExists, ImportFailed, Forbidden],
  }))
  .middleware(GitAuth);

const refs = HttpApiGroup.make("refs")
  .add(HttpApiEndpoint.get("list", "/repos/:owner/:repo/refs", {
    params: RepoPath,
    query: Schema.Struct({ prefix: Schema.optional(Schema.String) }),  // e.g. "refs/heads/"
    success: Schema.Struct({ head: Schema.NullOr(Schema.String), refs: Schema.Array(Ref) }),
    error: RepoNotFound,
  }))
  .add(HttpApiEndpoint.get("get", "/repos/:owner/:repo/ref", {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),           // query, not path — refnames contain '/'
    success: Ref,
    error: [RepoNotFound, RefNotFound],
  }))
  .add(HttpApiEndpoint.put("update", "/repos/:owner/:repo/ref", {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({
      newOid: Oid,
      expectedOid: Schema.optional(Schema.NullOr(Oid)),  // null = must-not-exist; absent = unconditional
    }),
    success: Ref,
    error: [RepoNotFound, RefConflict, ObjectNotFound, ReadOnlyRepo, Forbidden],
  }))
  .add(HttpApiEndpoint.del("remove", "/repos/:owner/:repo/ref", {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({ expectedOid: Schema.optional(Oid) }),
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, RefNotFound, RefConflict, ReadOnlyRepo, Forbidden],
  }))
  .middleware(GitAuth);

const objects = HttpApiGroup.make("objects")
  .add(HttpApiEndpoint.get("commit", "/repos/:owner/:repo/commits/:oid", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ oid: Oid }))),
    success: CommitInfo,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  }))
  .add(HttpApiEndpoint.get("log", "/repos/:owner/:repo/log", {
    params: RepoPath,
    query: Schema.Struct({
      ref: Schema.optional(Schema.String),             // refname or oid; default HEAD
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))),
    }),
    success: Paginated(CommitInfo),
    error: [RepoNotFound, RefNotFound],
  }))
  .add(HttpApiEndpoint.get("tree", "/repos/:owner/:repo/trees/:oid", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ oid: Oid }))),
    success: Schema.Struct({ oid: Oid, entries: Schema.Array(TreeEntry) }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  }))
  .add(HttpApiEndpoint.get("blob", "/repos/:owner/:repo/blobs/:oid", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ oid: Oid }))),
    success: Schema.Struct({
      oid: Oid, size: Schema.Number,
      encoding: Schema.Literals(["base64"]), content: Schema.String,  // ≤ 1 MiB only
    }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType, ObjectTooLarge],  // 422 → use /raw
  }))
  // Raw streaming reads are registered as RAW HttpRouter routes (octet-stream),
  // outside HttpApi schema-land by design (same policy as the git wire endpoints):
  //   GET /api/v1/repos/:owner/:repo/blobs/:oid/raw
  //   GET /api/v1/repos/:owner/:repo/file?ref=<refname|oid>&path=<path>   (tree-walk per segment)
  .middleware(GitAuth);

const tokens = HttpApiGroup.make("tokens")
  .add(HttpApiEndpoint.post("create", "/repos/:owner/:repo/tokens", {
    params: RepoPath,
    payload: Schema.Struct({
      name: Schema.String, scope: TokenScope,
      ttlSeconds: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
    }),
    success: CreatedToken,
    error: [RepoNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.get("list", "/repos/:owner/:repo/tokens", {
    params: RepoPath, success: Schema.Array(TokenInfo), error: [RepoNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.del("revoke", "/repos/:owner/:repo/tokens/:id", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ id: Schema.String }))),
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, TokenNotFound, Forbidden],
  }))
  .middleware(GitAuth);

export const GitApi = HttpApi.make("git-service")
  .add(repos).add(refs).add(objects).add(tokens)
  .prefix("/api/v1");
```

**Authorization matrix** (enforced in the Repo DO, §8): admin key → everything; repo `admin` token → its repo's write + token create/list/revoke + repo update/delete; `write` → its repo's reads + receive-pack + ref writes; `read` → its repo's reads + upload-pack only. Repo create/list-all/fork/import are admin-key-only.

`GitAuthLive` follows `StateAuthLive` exactly: `Layer.effect(GitAuth, ...)` returning `{ bearer, basic }` handlers that wrap the endpoint effect with a `Credentials` provision (Basic: password field is the token, username ignored). Handlers pass `Credentials` to Repo-DO RPCs, which are the enforcement point. Mounting uses the canonical composition — `HttpApiBuilder.layer(GitApi)` + group handler layers + `GitAuthLive` + `[Etag.layer, HttpPlatformStub, Path.layer]` (the `HttpPlatform` stub copied verbatim from `StateStore/Api.ts:333`) + `Layer.merge(rawRoutes)` + `HttpRouter.toHttpEffect` assigned to `fetch`.

---

## 6. Package layout — `packages/git`

Shape: **library-with-deployable-stack**, modeled on `packages/better-auth` — exports Worker/DO classes + the HttpApi contract for users to compose into their own Stacks, plus a canonical Stack factory and an example app.

```
packages/git/
  package.json                # @alchemy.run/git; exports ".", "./*" (types/bun/worker→src, import→lib);
                              # peerDeps: alchemy workspace:*, effect catalog:, @cloudflare/workers-types catalog:;
                              # devDeps: alchemy-test workspace:*, isomorphic-git (test-only wire client)
  tsconfig.json               # composite, extends ../../tsconfig.base.json, refs ../alchemy, paths @/* → src/*
  tsconfig.test.json
  src/
    index.ts                  # barrel: Api contract, error classes, GitWorker, Repo, Registry, GitService
    Api.ts                    # §5 verbatim — HttpApi contract + schemas + tagged errors + GitAuth tag
    Auth.ts                   # Credentials service, GitAuthLive, credential parsing (Basic/Bearer),
                              # admin-key timing-safe compare (crypto.subtle.timingSafeEqual)
    GitWorker.ts              # class GitWorker extends Cloudflare.Worker<GitWorker>()(...):
                              #   HttpApi mount, raw routes (git wire, /blobs/:oid/raw, /file),
                              #   Registry LRU cache, stub.fetch proxying, nodejs_compat + limits.cpu_ms
    RepoObject.ts             # class Repo extends Cloudflare.DurableObject<Repo>()("GitRepo") {} + Repo.make(impl):
                              #   RPC surface (verifyToken, createToken, listTokens, revokeToken,
                              #   getRepoMeta, updateRepoMeta, listRefs, getRef, updateRef, removeRef,
                              #   readObject, readCommitLog, readFileAtPath, snapshotRows (Stream),
                              #   startImport, startFork, startPurge)
                              #   + fetch (git wire choreography) + alarm (jobs: import/fork/purge/gc)
                              #   + in-memory push Semaphore
    RegistryObject.ts         # class Registry DO: createRepo, resolve, list, forkLineage,
                              #   bumpForkCount, markDeleted, remove
    Service.ts                # GitService(options?): a function returning an Effect the user
                              #   yields inside their OWN Alchemy.Stack; deploys GitWorker (+ DOs + R2
                              #   transitively) and returns { worker, url }. No Stack is shipped.
    git/                      # pure protocol/codec modules — no DO/R2 imports, unit-testable
      Pkt.ts                  # pkt-line read/write, flush/delim, ERR pkt; Stream transforms
      Sideband.ts             # band-1/2/3 framing transform (65515 cap)
      ObjectCodec.ts          # oid hashing (node:crypto sha1, incremental), loose header,
                              # commit/tree/tag parse + tree entry sort rules, varints
      Delta.ts                # copy/insert delta application, size verification
      PackParser.ts           # §3.6 ingest over a RandomAccess source; node:zlib Inflate.bytesWritten
      PackWriter.ts           # §3.5 no-delta emitter: header/count, varint+zdata concat, sha1 trailer
      Advertise.ts            # v0 advertisement builders (upload/receive capability sets, peeled tags)
      UploadPack.ts           # v0 fetch choreography: request parse, negotiation, shallow, closure driver
      ReceivePack.ts          # v0 push choreography: command parse, probe, ingest driver,
                              # connectivity check driver, report-status
      GzipBody.ts             # Content-Encoding: gzip detection + DecompressionStream + 1f8b sniff
    store/
      Sql.ts                  # DDL (§3.1), typed query helpers, chunked-IN utilities, transactionSync wrappers
      ObjectStore.ts          # row/r2/pack placement policy, batched reads, thresholds, staging, r2_key resolution
      Keys.ts                 # R2 key scheme (§3.2)
      Closure.ts              # commit BFS (gen-bounded), tree walk, visited set, depth bounds
    jobs/
      Import.ts               # alarm job: git HTTP client against source, PackParser reuse, status flips
      Fork.ts                 # alarm job: parent snapshotRows Stream → batched inserts, r2_key sharing
      Purge.ts                # alarm job: bounded R2 prefix delete loop (fork-count-gated), deleteAll, Registry removal
  test/
    fixtures/stack.ts         # user-authored Alchemy.Stack over GitService() — one per suite
    fixtures/packs/*.pack     # generated once by real git, checked in (never at test time)
    codec.test.ts             # pure: pkt-line, varints, delta apply, object hashing, tree sort
    pack.test.ts              # pure: parse/write round-trips against checked-in fixture packs
    GitService.test.ts        # REST lifecycle via HttpApiClient against deployed URL
    GitProtocol.e2e.test.ts   # real git CLI against deployed URL (§9)
    GitProtocol.wire.test.ts  # isomorphic-git in-process client: malformed packs, forced thin REF_DELTA,
                              # ERR-pkt / band-3 assertions
examples/git-service/
  alchemy.run.ts              # user-authored Alchemy.Stack yielding GitService()
  package.json                # alchemy deploy | dev | destroy | logs | tail
```

Conventions honored: no `Input<T>` in props; Effect 4 APIs only (`Effect.result` + `Result.*`, `Schema.TaggedErrorClass`, `Schema.Literals`, `Effect.fn`); no `async/await`/raw Node IO in handlers (Effect platform services; sync CPU crypto/zlib wrapped in `Effect.sync` at module boundaries, not per-byte); file-based `main: import.meta.url` (never inline `script` — unsupported in dev); `@/` path alias; test fixtures own their directory; DO RPC methods avoid the reserved name `delete`; JSDoc `@section`/`@example` on exported classes for `bun generate:api-reference` (synthetic provider dir like better-auth).

---

## 7. Core codec plan: write it in Effect; the zlib boundary is `node:zlib`

**Reuse verdict: write our own; port algorithms, import nothing (at runtime).** isomorphic-git is Promise-based, filesystem-shaped, and not streaming-safe under 128 MB (it *is* used as a **devDependency test client** for wire-level negative tests); wasm-git drags libgit2 through WASM for a problem that is ~1500 lines of well-specified codec; ripgit's Rust is the right recipe in the wrong language. The wire formats are small, frozen, and exhaustively documented — the risk is in choreography, not codecs, and choreography must be ours anyway. Everything is pure functions / Stream transforms in `src/git/` with zero platform imports, so the entire codec layer unit-tests in plain bun without a deploy. Port with attribution: `applyDelta` (~80 lines) and tree sort-order from isomorphic-git; OFS-delta offset codec cross-checked against ripgit and gitformat-pack.

**The zlib boundary (the one platform-sensitive decision), per empirical workerd verification (workerd 1.20260801.1):**

| Need | Tool | Why |
|---|---|---|
| Pack entry parsing (unknown compressed span) | `node:zlib` `createInflate()` per entry | `end` fires at `Z_STREAM_END` mid-`write` without `.end()`, and `inflate.bytesWritten` reports the **exact compressed bytes consumed** — the only way to find the next entry. Native, one instance per object, cheap. `DecompressionStream` is disqualified: errors on trailing bytes, doesn't report consumption. |
| One-shot inflate of an exactly-known span (blob reads via index) | `zlib.inflateSync` or `DecompressionStream("deflate")` | Spans are exact so strictness is fine. |
| Request-body gunzip | `DecompressionStream("gzip")` | Single well-formed stream; pipe-through. Branch on `Content-Encoding: gzip`, sniff `1f 8b` defensively. |
| Compression at rest | `zlib.deflateSync(content)` (level 6) | Only runs for delta-resolved objects — the ingest fast path stores the pack's compressed span **verbatim** for non-delta entries. |
| Hashing | `node:crypto` `createHash("sha1")` incremental | Pack trailers and large objects; loose ids hash `"<type> <size>\0" + content`. |

`git/PackParser.ts` (via a thin `Zlib` helper) is the **only** module allowed to touch `node:zlib`. No pako, no fflate.

Codec inventory: pkt-line reader/writer (65516 payload cap, flush/delim/ERR), sideband mux, type/size varint (little-endian 7-bit), OFS_DELTA offset (big-endian 7-bit **with the +1 bias per continuation** — the classic bug), delta instruction stream (copy/insert, `size==0 ⇒ 0x10000`), tree entry encode/parse with the `foo` < `foo/` directory sort quirk, commit/tag header parsing (continuation lines, gpgsig), pack header/trailer. Each has table-driven unit tests plus round-trip tests against real-git-generated fixture packs checked into `test/fixtures/packs/` (normal, thin, ofs-heavy, ref-delta, big-blob, empty), with `git index-pack --strict` / `git fsck` as the oracle for writer output.

---

## 8. Auth / token model

**Two credential kinds:**

1. **Admin key** — a single deployer-provisioned secret (`Config.redacted("GIT_SERVICE_ADMIN_TOKEN")` on the Worker, or Cloudflare Secrets Store via `ReadSecret` + `ReadSecretBinding`). Verified **at the Worker** with `crypto.subtle.timingSafeEqual`. Grants: repo create/update/delete/list-all, fork/import, and implicit admin on every repo. This solves the bootstrap problem (repo creation needs auth before any repo token exists). Intended topology (Artifacts' model): *the customer's own Worker* holds the admin key, applies its business authz, and mints short-lived repo tokens for its users/agents — who gets a token is the customer's problem.
2. **Per-repo tokens** — minted via `POST /repos/:o/:r/tokens` (and one bootstrap `write` token returned in `RepoCreated`), format `gs_<base64url(32 random bytes)>`, shown once. Stored as `hex(sha256(token))` in the **repo's own DO** `tokens` table with scope `read | write | admin`:
   - `read` → advertisement + upload-pack + all REST reads
   - `write` → read + receive-pack + REST ref writes (subject to `readOnly`)
   - `admin` → write + token create/list/revoke + repo update/delete

**Enforcement lives in the Repo DO** — the natural consequence of tokens living there. The Worker parses credentials (HttpApi middleware for REST; Basic header for git routes — username ignored, password = token, exactly how git credential helpers and `https://x:gs_...@host/o/r.git` remotes work; Bearer also accepted on REST) and forwards them; every Repo-DO RPC and the wire-protocol `fetch` handler starts with `verifyToken(sha256(token), requiredScope)` — a single indexed SQL lookup checking expiry (high-entropy token ⇒ hash lookup is not timing-sensitive), bumping `last_used_at` throttled to once/hour. Missing/invalid ⇒ REST: tagged `Unauthorized`/`Forbidden`; git wire: `401` + `WWW-Authenticate: Basic realm="git-service"` on `info/refs` (git retries with credentials), `ERR` pkt once a 200 has begun. `readOnly` repos: tokens still mint and read, but receive-pack and ref writes fail (`ng` / `ReadOnlyRepo`).

No users, no orgs, no OAuth in v1. The seam for v2 identity: `Credentials` is already a Context service — an OAuth-fronting worker (ripgit's pattern: verify at the edge, strip `Authorization`, forward actor headers over a service binding) slots in without touching the DO enforcement code.

---

## 9. v1 test plan sketch

**Tier 1 — pure codec (no cloud, milliseconds):** `codec.test.ts` / `pack.test.ts` in plain alchemy-test. Table-driven pkt-line/varint/delta/tree-sort cases; parse→write→parse round-trips on checked-in fixture packs (generated once by real `git pack-objects`, committed — never generated at test time); thin-pack resolution against a fixture object store; the OFS +1-bias multi-byte offset case; the `0x10000` copy-size case; tree-sort fsck cases; zlib-boundary accounting (concatenated streams, trailing junk, mid-chunk `Z_STREAM_END`); PackWriter output accepted by `git index-pack --strict`.

**Tier 2 — deployed REST (`GitService.test.ts`):** standard harness —

```ts
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(), state: Cloudflare.state() });
const stack = beforeAll(deploy(Stack));            // fixtures/stack.ts
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
```

`HttpApiClient.make(GitApi, { baseUrl: url })` driving: create repo (admin key) → `RepoCreated` carries a working bootstrap token → 409 on duplicate → PATCH description/readOnly → mint read/write tokens → token list is masked → refs empty on fresh repo → REST ref update with CAS (`RefConflict` on stale `expectedOid`, `ObjectNotFound` on bogus oid, `ReadOnlyRepo` when flagged) → typed 404s decode as the tagged classes → token TTL expiry (60 s + bounded `Effect.repeat` poll) and revocation → 401/403 after → delete → `status: "deleting"` → eventual 404. First requests retried through edge propagation (`Schedule.spaced("1500 millis"), times: 40`). Deterministic repo names; pre-test purge of leftovers (delete-if-exists before create).

**Tier 3 — real git CLI e2e (`GitProtocol.e2e.test.ts`, the money suite):** deploys the same stack; drives the actual `git` binary via the Effect platform `Command` service against `https://x:${token}@${host}/${owner}/${repo}.git`, work-trees under `FileSystem.makeTempDirectory` (Effect platform services only — no `node:fs`). Every step wrapped in bounded retries/timeouts per the speed doctrine (per-test ≤ 120 s):

1. **Empty-repo clone** — clone succeeds, warns empty, correct default branch (symref/unborn behavior).
2. **First push** — init, 3 commits (incl. an executable file, a symlink, a subdirectory), `git push` → `ok` report; REST `refs` + `commits/:oid` + `trees/:oid` + `/file` agree with `git rev-parse`/`git ls-tree`/`git show` byte-for-byte.
3. **Clone-back + fsck** — fresh clone, `git fsck --strict` clean, `git log` matches. (Transitively proves advertisement, negotiation, pack emission, object round-tripping.)
4. **Incremental fetch** — push 2 more commits from clone A; `git fetch` in clone B; fast-forward merge; content identical (asserts the haves/ACK path, not just re-clone).
5. **CAS / force push** — non-FF push rejected (`ng fetch first`), then `push --force` succeeds; fetch-after-force-push works in the other clone. **CAS race**: two clones push conflicting updates concurrently → exactly one `ok`, one `ng`; `--atomic` batch is all-or-nothing.
6. **Concurrent push serialization** — two parallel pushes to one repo → both eventually succeed (semaphore wait) or the second sees 503 + retry; never a corrupted repo.
7. **Branch + tag lifecycle** — push new branch, push **annotated** tag (round-trips as a tag object, peeled `^{}` in advertisement — ripgit's silent-drop bug is a named regression test), `git push --delete` both.
8. **Shallow** — `git clone --depth 1` succeeds; `git fetch --deepen 1` extends it.
9. **Large blob** — commit a 3 MiB random binary (deterministic seed), push, clone back, byte-identical (exercises `location='r2'` both directions).
10. **Big-ish push** (`skipIf(process.env.FAST)`) — ~2 000 deterministic commits (fixture script, cached tarball) push and clone within timeout (exercises thin-pack ingest with deep delta chains).
11. **readOnly** — flag repo readOnly, push → per-ref `ng`; unflag, push succeeds.
12. **Auth matrix** — read token clones but push → 403/`ng`; garbage token → 401 + git auth-retry stderr; token in remote URL works.
13. **Fork + import** — fork, poll `status` via `Effect.repeat` until `ready`, clone fork, histories identical, push divergent commit to fork → parent unaffected; **delete parent → fork still clones** (R2 fork-retention pin). Import from a sibling repo in the same deployment (avoids external flake), verify refs; optionally a small public repo depth-limited.
14. **Cleanup pin** — `stack.destroy()` at suite end; out-of-band distilled verification that the R2 prefix and Registry rows are gone (leak = provider bug by definition).

**Tier 3b — wire-level negative tests (`GitProtocol.wire.test.ts`):** isomorphic-git as an in-process HTTP client for cases needing byte-level control without shelling out: truncated pack → checksum `ng`; forced thin REF_DELTA against known base; pack referencing a missing tree → connectivity-check `ng`; oversize pack → clean in-band 50 MiB rejection; `ERR` pkt / band-3 assertions.

Per house rules: `bun run test test/... --profile testing` wrapped in `timeout 240`; `Effect.repeat` with bounded schedules for all polling (never `while(Date.now())`); deterministic names (never `Date.now()`); `NO_DESTROY=1` for local iteration.

---

## 10. Cut list & v2 seams

Every cut, its consequence, and the seam that makes it additive (seams marked **▲** are already load-bearing columns/interfaces in v1's shape):

| Cut | Consequence | Upgrade path |
|---|---|---|
| Protocol v2 | None visible — clients fall back to v0 silently | Additive: branch on `Git-Protocol: version=2` in `info/refs`, add `ls-refs` + `fetch` command handlers over the same `Closure` + `PackWriter` code. Advertisement/choreography are per-version files — a new file, not a rewrite. |
| ▲ Pack compaction / R2 packs (v1.1) | DO storage cost 13× R2 until it lands; 1 M-object manifest cap | `objects.location='pack'` + `pack_id`/`pack_offset` columns exist; emitter dispatches on location; alarm scaffolding present. Clone fast-path then streams whole entry-regions from R2 (B's verbatim-region trick — OFS offsets are entry-relative, so contiguous regions copy safely). |
| ▲ Streaming push > 50 MiB | Large initial pushes rejected (clean in-band report) | `PackParser` is written against `RandomAccess`; swap the memory buffer for an R2-multipart tee + ranged-read re-resolution. Plan body caps (100 MB Pro) remain the outer bound. |
| `thin-pack` / `ofs-delta` in **served** packs | Fatter fetches (~1.3–2×, no cross-object compression) | Delta-aware writer, or serve compaction packs (which may carry deltas) verbatim for clones. |
| `filter` (partial clone) | v0 clients warn and ignore; `--filter` unavailable | Advertise `filter`; `blob:none`/`blob:limit` are manifest predicates — the walk already knows types/sizes. |
| `include-tag` | Clients cope (fetch tags explicitly) | Tag-closure step in `Closure`. |
| `deepen-since` / `deepen-not` / `deepen-relative` (`git fetch --deepen`) | Rare flags fail (absolute `--depth <n>` deepening works) | ▲ `commits.commit_time` already stored; add walk predicates. |
| Multi-round minimal negotiation | Slightly fat incremental fetches (boundary snapshot redundancy) | ▲ Real common-ancestor negotiation over `commits`/`commit_parents` + `gen` — all data present. |
| `packfile-uris` | — | Natural once compacted packs exist: presigned R2 URLs for whole packs. |
| push-cert, push-options, hooks | Not advertised ⇒ clients don't send them | Advertise + parse; typed hook pipeline (pre-receive/update/post-receive) as an Effect service around `ReceivePack`. |
| Force-push / branch protection | Any write token can force-push | Policy table consulted inside the existing CAS `transactionSync` — pure addition. |
| Object-level GC | Unreachable objects persist (storage is the cheap resource) | Reachability sweep in the GC alarm; fork-aware deletion needs the refcount ledger below. |
| Shared-pack refcount ledger | Fork-retention rule is coarse (`fork_count > 0` retains the whole prefix forever) | Registry-maintained per-key refcounts on fork/delete → precise shared-object GC. |
| Dumb HTTP | None (modern git never falls back when smart content-types are correct) | Never. |
| SHA-256 repos | `object-format=sha1` advertised; mismatch rejected with `ERR` | ▲ `Oid` is branded; widen schema + dual hashing. |
| LFS | Large files ride normal objects up to the 64 MiB cap | LFS Batch API as an independent REST group + R2 streaming (chr33s reference); keys `{repoId}/lfs/<sha256>` reserved. |
| Registry sharding / global listing at scale | Singleton Registry serializes control-plane writes | ▲ `getByName("registry:" + owner)` — RPC interface unchanged. |
| Users / orgs / OAuth / public repos | Single admin key + capability tokens only | ▲ `Credentials` Context service boundary; edge-auth worker via service binding. |
| Cheap forks / big-repo import | Fork copies parent row bytes; import capped at 50 MiB pack | Falls out of compaction (bytes in shared R2 packs) + streaming ingest — both seams above. |
| PRs / issues / review | — | New tables in the Repo DO (it already holds the commit graph; merge-bases are `commit_parents` BFS), new HttpApi groups; the REST layer grows by group addition, not restructuring. |

---

*Implementable from this document plus the repo: start with `src/git/` (Tier-1 tests green offline), then `store/`, then `RepoObject.ts` choreography, then the Worker/API mount, then the e2e suite. `packages/alchemy/src/Cloudflare/StateStore/Api.ts` is the mounting reference; `test/Cloudflare/Workers/fixtures/http-api/` is the Worker+DO+R2 reference; `packages/better-auth` is the packaging reference.*
---

# Part II — v2: scaling to enormous repositories

v1 is deliberately one Durable Object per repo holding **everything**: refs,
the object index, and the object bytes. That buys transactional ref CAS for
free and is provably correct (Part I), but it caps out on two axes:

- **Storage** — DO SQLite is 10 GB, so bytes-in-rows caps a repo at ~10 GB.
- **Bandwidth** — every clone byte transits one single-threaded DO in one
  datacenter. No horizontal read scaling, no geographic spread.

The v2 insight: **a git repo is 99.9% immutable content-addressed bytes and
0.1% mutable transactional state.** Immutable content-addressed data needs
*zero* coordination, so it should never live behind a coordination point.
Sharding the DO would be solving a problem we should not have. Instead,
split the planes.

## 11. The three planes

| Plane | Home | Holds | Scales by |
|---|---|---|---|
| **Refs** (mutable) | Repo DO | refs, tokens, config, push staging, commit graph | Nothing needed — kilobytes; the only thing that requires serialized CAS |
| **Objects** (immutable) | R2 | content-addressed packs + pack indexes + clone bundles | R2 (unbounded, immutable keys, no per-key write contention) |
| **Serving** (stateless) | Workers + Cache API | advertisement, negotiation, pack streaming | Per-PoP: every datacenter serves independently |

The DO stays the authority for "what is the current tip", which is the only
question that needs an authority. Everything else is content-addressed and
therefore cacheable, shareable, and replicable without coordination.

### 11.1 Why this is the right shape

This is the same refs-in-database + objects-in-blob-store architecture that
GitHub (Spokes), GitLab (Gitaly + object storage), and AWS CodeCommit
(DynamoDB + S3) converged on, expressed in Cloudflare primitives. The
difference from v1 is not "more machines" — it is *removing the byte path
from the coordination point*.

### 11.2 Request flows after v2

```
clone (warm)   client → Worker → Cache API hit                    (DO: 0 calls, R2: 0 gets)
clone (cold)   client → Worker → DO.planClone (refs only, ~1 KB)
                              → R2 GET bundle → stream to client  (DO: 1 tiny RPC)
fetch (incr.)  client → Worker → DO.planFetch (negotiate on the
                              commit graph) → R2 ranged reads     (DO: 1 tiny RPC)
push           client → Worker → DO (ingest + CAS, unchanged)     (serialized, by design)
```

## 12. Object plane: packs, indexes, bundles

### 12.1 Compaction (loose rows → R2 packs)

An alarm fires when `SUM(zsize) WHERE location='row'` exceeds **1 GB** or the
live loose count exceeds **50 000**. It streams a no-delta pack of the
oldest N objects to R2 via multipart (5 MiB parts), then flips those rows to
`location='pack'` with `pack_id`/`pack_offset` in one `transactionSync` and
NULLs their `zdata`.

Because objects are stored **pre-deflated** (v1's decision, made for CPU
reasons), a pack is literally `varint header + zdata` concatenated — so
compaction is a copy, not a recompression, and `pack_offset` points at a
byte span that can be served by an R2 ranged read verbatim.

Keys are content-addressed and immutable:

```
{repoId}/packs/pack-{sha1}.pack     compacted objects (immutable)
{repoId}/bundles/bundle-{refsHash}.pack   full-clone bundle (immutable)
{repoId}/objects/{oid}              oversize loose objects (v1, unchanged)
```

### 12.2 Clone bundles

A clone is, on the wire, exactly one pack containing the closure of the
advertised refs. v1 recomputes that pack per clone. A **bundle** computes it
once, after pushes settle (debounced alarm), and stores it under a key
derived from the ref snapshot it covers (`refsHash`).

Serving a clone then becomes: match the request's wants against the current
advertisement, and if they agree, stream the bundle bytes. No closure walk,
no per-object reads, no compression — and the bytes are immutable, so the
Cache API can serve them from every PoP.

Staleness is handled in three escalating tiers:

1. **Exact match** (v2.0) — bundle covers exactly the current refs → stream
   it; otherwise fall back to dynamic assembly. Hot repos with bursty clone
   traffic (CI fleets cloning the same tip) hit this nearly always.
2. **`packfile-uris`** (v2.1, needs protocol v2) — the server hands the
   client a CDN URL for the big pack and sends only the remainder in-band.
   The bundle no longer has to be current, only *mostly* current.
3. **`bundle-uri`** (v2.2, git ≥ 2.38) — advertise a base bundle plus
   incrementals with `creationToken`s; the client fetches them all from
   cache and then does an ordinary incremental fetch. Server work per clone
   collapses to a tiny negotiation.

Bundles are derived data: GC keeps the newest base plus K incrementals and
deletes older ones lazily. Because keys are content-addressed, a new bundle
never overwrites an in-flight one.

### 12.3 The object index at scale

If the index itself outgrows the DO (~10M+ objects), the answer is again not
a shard: the **pack index files in R2 are the index** (binary-searchable by
oid), and the oid's own hash prefix is a perfectly uniform partition key if
they ever need splitting. Content addressing *is* the trie — there is no
tree structure to invent.

## 13. Serving plane: Workers + Cache API

- **Advertisement caching.** `GET /info/refs` output changes only on push,
  so it is cached under a key derived from the repo id + refs hash and
  purged on push. A clone storm then costs the DO ~one call *per push*
  rather than one per clone.
- **Worker-side clone fast path.** The Worker asks the DO for a *plan*
  (`planClone`: refs snapshot + bundle key, ~1 KB) and, when the plan says
  "bundle", streams R2 → client itself, framing sideband as it goes. The DO
  never touches a pack byte.
- **Dynamic fetches** stay proxied to the DO in v2.0 (they need the commit
  graph); v2.1 moves negotiation to the Worker over a cached commit-graph
  file, leaving the DO purely as the ref authority.

## 14. Scaling model (napkin math)

Everything is per-repo; repos are independent DOs, so fleet capacity is the
sum. These are estimates derived from platform limits and architecture, not
measurements — §15 is the plan to replace them with numbers.

| Dimension | v1 (as built) | v2 (this design) | Bound by |
|---|---|---|---|
| Clone bandwidth (per repo) | ~50–100 MB/s aggregate | edge line rate; Tbps-class aggregate | v1: one DO streams every byte. v2: immutable bytes in cache/R2 |
| Clone TPS (per repo) | ~50–200/s | 10k+/s | v2: advertisement cached; DO called ~once per push |
| Incremental fetch | ~1–5 s CPU per 1M-object closure | ms for recent tips | commit graph + (v2.1) bitmaps |
| Push TPS (per repo) | ~3–10/s | ~5–20/s | **Inherent**: a ref is a serialization point in git's own semantics |
| Repo size | ~10 GB | unbounded (R2) | DO SQLite cap lifted off the byte path |
| Push size | 50 MiB | unbounded | `RandomAccess` seam → R2 multipart tee |

**v2 makes reads scale like a CDN and leaves writes scaling like git** —
which is the correct place to land, because git's semantics cap per-ref
write concurrency regardless of who hosts it.

## 15. Remaining bottlenecks (ranked) and how each is measured

1. **Cold closure computation on enormous repos.** A 10M-object visited set
   as a JS `Set` is ~400 MB–1 GB, over the Worker's 128 MB. Fix is git's own:
   binary commit-graph + **reachability bitmaps** (EWAH), turning a 10M-node
   walk into bitmap ANDs over a few MB. This is the hardest real engineering
   on the path to enormous repos.
2. ~~**Subrequest limit (1000) vs. fragmented packs.**~~ **Addressed**
   (§16.2): pack reads are served from window-aligned slabs, so a fetch
   costs a handful of R2 GETs rather than one per object (68.2 s → 1.16 s
   on a 1202-object pack). Remaining work is pack *ordering* — laying out
   compaction output so a typical fetch touches few windows — which is an
   optimization now rather than a cliff.
3. **Per-repo push serialization.** Inherent (see above); measured, not
   fixed.
4. **Registry singleton** — ~500 control-plane ops/s globally. Resolve
   caching shields reads; `getByName("registry:" + owner)` shards writes.
5. **First-byte latency for distant clients** — the refs DO lives in one
   datacenter. Cached advertisements hide most of it; location hints place
   hot repos near their users.
6. **R2 write throughput during compaction/bundling** — a large repack is
   minutes of alarm work; must use the bounded-per-run + re-arm pattern the
   purge job already uses (15-minute alarm budget).

Each gets a benchmark in `test/GitBench.e2e.test.ts` (§16) so the table
above becomes measured numbers rather than estimates.

## 16. Measured (test/GitBench.e2e.test.ts, deployed, SCALE=1)

Run: `bun run test test/GitBench.e2e.test.ts --profile testing`
(`BENCH_SCALE=4` for 4× workloads). Each case asserts only correctness and
prints a line, so a slow datacenter minute can never fail the suite.

### 16.1 End-to-end (via the `git` CLI, so client cost is included)

| Measurement | Result | Reading |
|---|---|---|
| push 300 commits | 2.0 s (147 commits/s) | one push, ingest-dominated |
| clone — dynamic closure walk | 1.17 s | v1 path: walk + per-object reads |
| **clone — R2 bundle** | **0.44 s** | **2.7× faster** |
| clone — fully packed repo (ranged R2 reads) | 0.60 s | compaction costs ~35% vs bundle, still beats dynamic |
| incremental fetch (1 commit) | 477 ms | 2 round trips + negotiation |
| 8 concurrent clones, 256 KiB each | 9.9–10.7 clones/s | bound by `git` process spawn + TLS, **not** by the server |
| 10 serial pushes (same branch) | 4.6 pushes/s | the predicted per-ref serialization floor |
| 4 concurrent pushes (distinct branches) | 9.2 pushes/s | DO semaphore serializes ingest, by design |
| 10 concurrent repo creates | 7.9–12 creates/s | Registry singleton |
| repo GET (resolve-cached) | 25 ms | in-isolate cache hit |
| repo LIST, 13 rows → 14 rows | **416 ms → 27 ms** | **15×** after fixing the N+1 (below) |
| compact 202 loose objects → R2 | 0.9 s | ~220 objects/s |

### 16.2 Server capacity — the v2 claim, measured

Driving `git-upload-pack` over raw HTTP removes the client from the
measurement. Comparing the bundle path against the dynamic closure walk
(forced by sending a `have` the server does not know, which disqualifies
the bundle while producing the identical pack) is like-for-like:

| Concurrency | dynamic closure walk (v1 path) | R2 bundle via Worker (v2 path) |
|---|---|---|
| 1 | 4.7 clones/s, 2.4 MiB/s | 5.4 clones/s, 2.7 MiB/s |
| 8 | 17.2 clones/s, 8.7 MiB/s | 17.9 clones/s, 9.1 MiB/s |
| **32** | **20.2 clones/s, 10.2 MiB/s** | **62.1 clones/s, 31.5 MiB/s** |

Dynamic fetch over a **compacted** repo (1202 objects in one R2 pack), the
case bottleneck #2 warned about:

| | |
|---|---|
| one ranged GET per object (naive) | **68.2 s** for a 53 KiB fetch |
| coalesced window reads | **1.16 s** (59×) |

Reading a pack object-by-object costs one serialized R2 round trip each.
Window-aligned slabs (4 MiB, ≤6 retained) mean touching any object fetches
its whole neighbourhood once, so a small pack collapses to a single GET —
and the Workers subrequest budget stops being a correctness cliff.

This is the design's central claim, measured. The dynamic path **saturates
at ~20 clones/s** — one Durable Object's single-threaded ceiling, and more
load does not improve it — while the bundle path keeps scaling with
concurrency (3.1× at 32-way, still climbing). Serialized planes flatten;
immutable content-addressed bytes served by Workers do not.

### 16.3 Real world: this repository (test/GitRealWorld.e2e.test.ts)

The strongest test we have is pushing the alchemy monorepo itself — a
depth-1 tree re-committed as one root commit, which keeps the real object
count and byte volume while staying fully connected (pushing from a shallow
clone would reference parents the server does not have, which receive-pack
correctly refuses):

| Step | Result |
|---|---|
| push 12,315 files / 13,699 objects / 38.1 MiB | 20.6 s |
| clone back, loose objects | 19.5 s |
| **clone back after compaction (R2 packs)** | **3.4 s — 5.7×** |
| `git fsck --strict`, HEAD and tree oid equality | identical |
| incremental push on top | works |

Compaction making clones **5.7× faster** on a real repo is the v2 storage
plane paying off end to end: the same objects, read as a few large ranged
GETs out of an immutable pack instead of thousands of row reads.

Verification note: the suite deliberately does **not** `diff -r` the two
working trees. Tree-oid equality is the stronger and correct assertion —
identical tree oids mean every path, mode and blob matches — whereas a
directory diff also compares things git does not track (empty directories,
submodule mount points), which legitimately differ between a working tree
and a fresh clone of it.

### 16.4 Push size: the cap is gone, the large path needs a cursor

A push larger than the in-memory threshold is **no longer rejected**. The
body is parked in R2 and parsed back through `store/PackSource.ts`, an
R2-backed `RandomAccess` with window-coalesced reads — the seam
`PackParser` was written against from the start. The DO's ingest now runs
on `PackParser` (which the pack fixtures cover directly) rather than its
own buffer-only copy.

Getting there took one real fix. `PackParser` read **the entire remainder
of the pack for every entry** (`source.read(offset, dataEnd - offset)`).
On a buffer that is free — a subarray view — which is why nobody noticed;
against R2 it copies ~19 MiB per entry, so a 13.7k-object pack moved
hundreds of gigabytes and blew a 600 s timeout. Entries are a few KiB, so
the parser now reads a bounded 512 KiB window and grows it only for the
rare object whose compressed stream runs past it.

| 38 MiB alchemy push | before | after |
|---|---|---|
| via R2 (streamed ingest) | >600 s (timeout) | **44.4 s** |
| in memory | 20.6 s | 20.6 s |

So the R2 path costs about **2×** memory rather than 30×, and the
threshold ships at 32 MiB — comfortably inside a 128 MB isolate, covering
the overwhelming majority of pushes at full speed, with anything larger
merely slower instead of refused.

### 16.5 Ingest batching, and what it revealed

Staging cost **two statements per object** — an existence probe and an
insert — so a 13.7k-object push ran ~27k statements and ~13.7k transactions
inside one single-threaded Durable Object. Ingest now stages in batches of
256 (or 8 MiB) via a single `transactionSync` with `INSERT OR IGNORE` (no
probe), adopting crashed-push rows with one chunked `UPDATE`, and the
parser hands the sink its already-inflated bytes so commits/trees are not
inflated twice.

    38 MiB alchemy push via R2:  44.4s -> 37.4s
    clone back:                  18.5s -> 16.6s

A 16% win, not the 5x the statement count suggested — which is the useful
result: **transaction commits were not the dominant cost**. What remains is
per-object work that batching cannot remove (inflate, sha1, one statement
each, Effect frames) plus, importantly, *client-side* cost the measurement
does not separate: `git push` also packs 13.7k objects locally and uploads
38 MiB over the tester's uplink. Isolating server ingest needs either
server-side timing or a loopback baseline — until then these numbers are an
upper bound on server cost, not a measurement of it.

The deeper point is that this work is **serial by construction**: one repo
is one Durable Object, and a push is one request to it. No amount of
horizontal Worker/R2 scale touches it. Making a single large push
dramatically faster requires parallelism *within* the repo — see §17.

### 16.6 What the measurements corrected

1. **`repos.list` was O(N) Durable Object wakes** — the handler fanned out
   `getRepoMeta` per row, so listing 100 repos woke 100 DOs. **Fixed**:
   `default_branch` / `read_only` / `status` are denormalised onto the
   registry row (the Repo DO pushes them on change and remains the source
   of truth). 416 ms → 27 ms. Live `objects` stats still need the DO, so a
   listing reports zeros there and callers who want them read the repo
   directly. Note for future schema work: the Registry needed an explicit
   `ALTER TABLE` migration, because `CREATE TABLE IF NOT EXISTS` silently
   leaves an existing table's columns alone.
2. **Small-clone throughput is round-trip-bound, not bandwidth-bound.** At
   256 KiB per clone the git client's process spawn plus two HTTP round
   trips dominate, so the bundle win shows up as latency; the bandwidth
   ceiling only appears under raw concurrency (§16.2) or on much larger
   repos.
3. **Advertisement caching is deliberately NOT implemented.** A TTL cache
   on `info/refs` would make "push, then fetch from another machine"
   unreliable for the length of the TTL — a real correctness regression for
   CI. Doing it properly means an epoch the Worker can read without asking
   the DO (Cache API entry purged on push), which is a v2.1 item; the
   remaining per-clone DO cost is two small RPCs, and §16.2 shows that is
   not the ceiling.

---

# Part III — v3: the maximum-performance DO architecture

## 17. Why v2 still has a floor

v2 made *reads* scale (immutable bytes served by Workers from R2) and left
*writes* where git semantics put them. But the measurements in §16 expose a
floor that no amount of horizontal scale removes:

- one repo = one Durable Object = **one thread**;
- a push is **one request** to it;
- ingest is ~13.7k objects × (inflate + sha1 + one statement + Effect
  frames), strictly serial.

Batching transactions bought 16% (§16.5) — proof that the remaining cost is
per-object work, not commit overhead. Making a large push an order of
magnitude faster requires parallelism **inside the repo**.

The enabling observation: a repo holds two kinds of state with completely
different constraints.

| | mutability | ordering | consequence |
|---|---|---|---|
| refs, tokens | mutable | CAS, strictly serialized | must live in one DO |
| objects | **immutable, content-addressed** | **none whatsoever** | can be written anywhere, in any order, in parallel |

Object writes are serialized today only because they share a DO with the
refs. That serialization is *accidental*, not essential.

## 18. Target architecture

| Tier | Instances | Holds | Why here |
|---|---|---|---|
| **Worker** | horizontal | pack parsing (inflate + sha1), fan-out, response assembly | stateless CPU; parsing has no reason to sit in a coordination point |
| **Ref DO** | 1 / repo | refs, tokens, commit graph, push staging state, CAS | the only thing git forces to serialize |
| **Object shard DO** | N / repo, by oid prefix | content-addressed objects (hot tier) | independent writes ⇒ N-way parallel; N × 10 GB ceiling |
| **R2** | — | compacted packs, clone bundles | immutable bulk, ranged reads, no egress |

**Sharding key: the oid itself.** An oid is a uniform hash, so a fixed
2-hex-char prefix distributes perfectly with zero rebalancing. A trie or
dynamic split solves skewed key distributions — a problem content
addressing does not have. Fix `N = 256` at repo creation and never reshard:
256 × 10 GB = 2.5 TB per repo.

**Why fan-out is safe.** Staging across shards is not atomic and does not
need to be: objects are immutable and content-addressed, so a partial write
is inert (worst case some staged rows are GC'd). The only atomic step is
the ref CAS in the ref DO, which runs after the connectivity check passes.
Sharding never touches the consistency-critical path.

**Cost shape.** DO *instances* are not billed; requests, active duration and
storage are. Fan-out means one RPC per shard **touched** (objects batched
per shard), so ~256 requests for a large push (~$0.00004) and far *less*
total active duration, since 256 DOs busy ~50 ms beats one DO busy 20 s.
The real costs are cold-start latency across shards and a wider failure
surface — both mitigated by immutability making every retry free.

## 19. Phases

**Phase 0 — measure honestly (prerequisite). DONE — and it settled the
question.** Repos now report `lastPush` timing measured inside the Durable
Object. For the 38 MiB / 13,701-object alchemy push:

| | |
|---|---|
| **server ingest** | **27.0 s** |
| connectivity check | ~0 ms |
| ref CAS finalize | ~0 ms |
| **server total** | **28.7 s of a 32.3 s wall clock (89%)** |
| client + network | 3.5 s |

So the earlier suspicion that client packing and upload dominated was
**wrong**: the server owns 89% of the time, and effectively all of it is
the per-object ingest loop at **2.10 ms/object**. Connectivity and CAS —
the parts that genuinely must be serialized — are free.

**Phase 0b — where the ingest time actually goes.** Splitting `ingestMs`
settled the next question too:

| | | |
|---|---|---|
| SQL staging | 2.0 s | **9%** |
| CPU (inflate, sha1, parse, Effect frames) | 20.4 s | **91%** |

So **sharding storage addresses only 9%** of push cost. It remains valuable
for the 10 GB → 2.5 TB capacity ceiling, but it is not the throughput fix.
The throughput fix is per-object CPU — and 1.49 ms to inflate ~2.7 KB and
hash it is ~50x the cost of the actual work, i.e. it is overhead, not
computation.

First cut at that overhead: `zlib.createInflate()` built a Node Transform
stream (EventEmitter, buffers) and took an async event-loop round trip **per
object**. Driving the engine synchronously the way Node's own `inflateSync`
does removes both:

    CPU        20.4s -> 15.9s     per object  1.74ms -> 1.42ms
    wall clock 28.1s -> 23.2s

with a hard-won caveat baked into the code: workerd's `node:zlib` shim
returns only the *first chunk* (observed: 525,107 bytes of a 1,337,267-byte
object) and reports a plausible `bytesWritten` alongside it, where Node
loops until done. The fast path therefore validates its output against the
size the pack header already declares and falls back to the stream path on
any mismatch — silent truncation would otherwise corrupt objects. Pack
fixtures alone would not have caught this; only the deployed push did.

Remaining per-object overhead to attack next, in order: `crypto.createHash`
allocated per object (same shape of problem as `createInflate`), Effect
frames in the sink, and window slicing.

That is still the argument for phases 1–2, but with corrected weights: the expensive work
(inflate, sha1, one insert) is *per object* and has no ordering
requirement, yet runs single-threaded because it shares a DO with the refs.
At 2.10 ms/object, 16-way fan-out puts a 13.7k-object push at ~1.7 s.

**Phase 1 — hoist pack parsing to the Worker.** Inflate + sha1 for every
object currently runs on the ref DO's single thread; it is stateless CPU.
Moving it to the Worker frees the DO and is the prerequisite for fan-out
(the Worker must hold resolved objects to route them).

**Phase 2 — shard the object store.** `ObjectShard` DO addressed
`{repoId}:{oidPrefix}`; `ObjectStore` becomes a router that batches by
prefix and writes shards in parallel. Connectivity checks become N parallel
batched queries. Compaction runs per shard, producing per-shard R2 packs.

**Phase 3 — parallel fetch assembly.** A dynamic fetch reads its manifest
from N shards concurrently instead of walking one DO.

**Phase 4 — reachability bitmaps.** With throughput fixed, the remaining
ceiling is closure computation on multi-million-object repos: EWAH bitmaps
over the commit graph replace the visited-set walk.

Expected shape of the win: 13.7k objects at ~1.5 ms serial ≈ 20 s; fanned
across even 16 shards with parsing overlapped in the Worker ≈ 1–2 s.
