# How Cloudflare's `agents` / `think` implement durable execution in Durable Objects

Research report on the mechanics of durable, long-running agent work in the
`cloudflare/agents` monorepo (vendored at `.vendor/agents`), and what an
Effect-based DO kernel (our `KernelCloudflare`) should steal from it.

All paths below are relative to `.vendor/agents/`. Line numbers are from the
vendored checkout (2026-07).

---

## Executive summary

The whole durability story reduces to **four durable artifacts plus one alarm
protocol**:

1. **A "run row" written BEFORE work starts** (`cf_agents_runs`): `runFiber()`
   inserts `{id, name, snapshot, created_at}` into SQLite synchronously before
   executing the callback and deletes it in a `finally`. A row that exists on
   wake with no in-memory execution *is* the crash detector. `ctx.stash(data)`
   overwrites the `snapshot` column synchronously, so the last checkpoint is
   always durable.
2. **A wake-scan invoked from BOTH entry points** — `onStart()` (wrapped by the
   framework so it runs on every activation, before user code) and the alarm
   handler both call `_checkRunFibers()`, which SELECTs orphaned run rows and
   invokes `onFiberRecovered({id, name, snapshot, createdAt})` per row. The
   original closure is gone forever; recovery is a *policy hook* that decides
   resume / compensate / drop from the name + snapshot.
3. **A single multiplexed alarm** (`_scheduleNextAlarm()`): one storage alarm
   armed to `min(next schedule row, hung-interval recheck, keepAlive heartbeat,
   fiber-recovery backoff, facet-recovery heartbeat)`. `keepAlive()` is just a
   ref-count that forces the alarm to fire every 30s so the DO's inactivity
   timer never elapses mid-work; crucially, while an orphaned fiber row exists
   the alarm re-arms *itself*, so a background agent with no clients still wakes
   up and recovers.
4. **A durable attempt/budget record per incident** (chat recovery): a small
   JSON blob keyed by `rootRequestId:latestUserMessageId` carrying `attempt`,
   `maxAttempts`, `lastAttemptAt`, `lastProgressAt`, a durable monotonic
   `progress` counter, a `workBaseline`, and `oomAttempts`. Budgets are
   **progress-keyed, not wall-clock-keyed**: any attempt that produced new
   durably-flushed content resets the attempt counter, a 30s debounce collapses
   deploy-storm redetections into one attempt, and four independent bounds
   (no-progress window 5min, attempt cap 10, work budget 1000, OOM budget 3)
   seal the incident. Exhaustion always terminalizes visibly (`onExhausted` +
   terminal message + submission marked interrupted) — never a silent drop, and
   never an infinite crash loop.

On top of this, Think adds a **turn ledger** (`cf_think_submissions`: pending →
running → terminal, with idempotency keys and messages applied only when the
turn starts), an in-memory **turn queue** that serializes all model turns, a
**transcript repair pass** that flips unsettled tool calls to errored results
before re-prompting, and a **progress-keyed re-attach** protocol for parent ↔
child agent RPC.

---

## 1. Fibers: `runFiber` / `startFiber`

### What a fiber is

A *fiber* is an in-process async function execution registered in SQLite for
crash detection. It is **not** resumable code — the closure dies with the
isolate. What survives is a row identifying the work plus the last checkpoint.

`packages/agents/src/index.ts:5440-5445`:

```ts
async runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T> {
  return this._runFiberInternal(nanoid(), name, fn);
}
```

### Persisted state

Two tables (`index.ts:2141-2199`):

```sql
-- v3: one row per LIVE fiber execution; presence on wake = interrupted
CREATE TABLE IF NOT EXISTS cf_agents_runs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  snapshot TEXT,
  created_at INTEGER NOT NULL
)

-- v8: managed fiber job ledger for idempotent acceptance,
-- inspection, cancellation, and terminal cleanup.
CREATE TABLE IF NOT EXISTS cf_agents_fibers (
  fiber_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending|running|completed|aborted|interrupted|error
  snapshot TEXT,
  metadata_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
)
```

`cf_agents_runs` is the **transient liveness row** (deleted on completion,
success or failure). `cf_agents_fibers` is the **durable ledger** used only by
`startFiber()` for idempotent acceptance and later inspection; a managed fiber
has both rows while running.

### When rows are written

`_runFiberInternal` (`index.ts:5620-5740`) — the row is inserted *before* `fn`
runs, snapshot updates are synchronous SQLite writes, deletion happens in
`finally`:

```ts
this.sql`INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
         VALUES (${id}, ${name}, NULL, ${Date.now()})`;
...
const writeSnapshot = (data: unknown) => {
  const snapshot = JSON.stringify(data);
  this.sql`UPDATE cf_agents_runs SET snapshot = ${snapshot} WHERE id = ${id}`;
  // managed fibers mirror the snapshot into cf_agents_fibers
};
...
dispose = await this.keepAlive();               // heartbeat held for the duration
const result = await _fiberALS.run({ id, signal, stash }, () =>
  fn({ id, signal, stash, snapshot: null }));
...
} finally {
  this._runFiberActiveFibers.delete(id);
  this.sql`DELETE FROM cf_agents_runs WHERE id = ${id}`;
  dispose();
}
```

`stash()` is documented as synchronous-durable (`docs/agents/durable-execution.md:395`):
"`ctx.stash(data)` writes to SQLite **synchronously**. There is no async gap
between 'I decided to save' and 'it is saved.'" Each stash **fully replaces**
the snapshot. `this.stash()` resolves the current fiber via `AsyncLocalStorage`
(`_fiberALS`), so nested helpers can checkpoint without threading `ctx`.

### The resume mechanism after eviction/deploy

There is **no constructor hook and no blockConcurrencyWhile for fibers**. Two
convergent paths, both landing on `_checkRunFibers()`:

1. **`onStart` path (primary).** The framework wraps user `onStart` in the
   constructor; on every activation it restores facet identity + MCP
   connections, then runs the recovery scan *before* the user's `onStart`
   (`index.ts:2759-2768`):

```ts
const startupAgentToolRunIds = await this._withAgentSpan(
  "recover_agent_work", "startup", {},
  async () => {
    this._checkOrphanedWorkflows();
    await this._checkRunFibers();
    return this._agentToolRunRecoveryRunIds();
  });
```

2. **Alarm path (fallback, and the only path for clientless background
   agents).** The persisted storage alarm survives eviction; `alarm()` runs
   `super.alarm()` (which itself triggers PartyServer init → `onStart`), then
   due schedules, then `_onAlarmHousekeeping()` → `_checkRunFibers()` +
   `_checkFacetRunFibers()` (`index.ts:6784, 5969-5972`).

Both paths are idempotent and mutually protected by a re-entrancy flag
(`_runFiberRecoveryInProgress`).

### How a freshly woken DO discovers in-flight fibers

`_checkRunFibers` (`index.ts:5789-5966`) selects **all** rows of
`cf_agents_runs` and skips those whose ids are in the in-memory
`_runFiberActiveFibers` set (i.e. actually running in this isolate). Everything
else is an orphan left by a dead isolate:

```ts
const rows = this.sql`SELECT id, name, snapshot, created_at FROM cf_agents_runs`;
for (const row of rows) {
  if (this._runFiberActiveFibers.has(row.id)) continue;   // live, not orphaned
  const ctx = { id: row.id, name: row.name, snapshot, createdAt: row.created_at,
                recoveryReason: "interrupted" };
  ...
  const recovered = await this._runFiberRecoveryHook(ctx, managedRow);
  if (recovered || managedRow || tooOld) {
    this.sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
  }
}
```

For managed fibers the ledger row is flipped to `'interrupted'` (with the
orphan's snapshot copied over) before the hook runs. A second scan pass handles
**ledger-only** orphans — `cf_agents_fibers` rows stuck `pending|running` with
no `cf_agents_runs` row (a crash between ledger insert and run-row insert) —
by marking them `interrupted` and running the same hook (`index.ts:5888-5952`).

The hook is `onFiberRecovered(ctx)` (overridable; internal framework fibers are
intercepted first by `_handleInternalFiberRecovery`, which is how Think hijacks
chat fibers). The doc is explicit about semantics
(`docs/agents/durable-execution.md:460-465`):

> **The original lambda is gone.** On recovery, you only have the `name` and
> `snapshot`. … **The row is deleted after the hook returns successfully.** If
> you want to continue the work, call `runFiber()` again inside the hook. …
> **If the hook throws, the row is kept (up to a bound).**

### At-least-once semantics and idempotency

- The run row is deleted only **after** the recovery hook returns, so recovery
  is at-least-once: a crash mid-hook re-runs it on the next scan.
- A throwing hook keeps the row and is retried on the alarm backoff until the
  row exceeds `fiberRecoveryMaxAgeMs` (default 24h, `index.ts:1310`), after
  which it is dropped with a `fiber:recovery:skipped (max_age_exceeded)` event.
- Idempotency of the *body* is the user's job, aided by two framework tools:
  `ctx.stash()` (record completed steps so recovery resumes past them) and
  `startFiber({ idempotencyKey })` (durable acceptance dedupe — a duplicate
  webhook delivery gets `accepted: false` and can join the in-memory execution
  or read the retained terminal status; `index.ts:5464-5566`).
- `startFiber` cancellation is cooperative: `cancelFiber` writes `'aborted'` to
  the ledger and aborts `ctx.signal` if running locally (`index.ts:5321-5338`).

### Fibers in sub-agents (facets)

Facets have no alarm slot. When a facet starts a fiber it registers a root-side
index row in `cf_agents_facet_runs` (`owner_path_key, run_id`); root alarm
housekeeping iterates that index and RPCs `_cf_checkRunFibersForFacet` into
each owning facet, pruning the lease when the facet reports zero remaining rows
(`index.ts:2154-2167, 5992-6040`). Authoritative rows and snapshots stay in the
facet's own storage.

---

## 2. Attempt bounding: `maxAttempts`, `stableTimeoutMs`, `onExhausted`

Raw fibers have **no automatic retries** ("Recovery logic belongs in
`onFiberRecovered`", docs). All bounding lives in the **chat-recovery incident
layer**, shared by `AIChatAgent` and `Think`
(`packages/agents/src/chat/recovery-incident.ts` + `recovery-engine.ts`).

### The durable incident record

`recovery-incident.ts:47-102` — persisted in DO KV under
`cf:chat-recovery:incident:{rootRequestId}:{latestUserMessageId}`:

```ts
export type ChatRecoveryIncident = {
  incidentId: string;
  requestId: string;
  recoveryRootRequestId?: string;   // stable across the whole continuation chain
  recoveryKind: "retry" | "continue";
  attempt: number;
  maxAttempts: number;
  status: "detected"|"scheduled"|"attempting"|"completed"|"skipped"|"exhausted"|"failed";
  firstSeenAt: number;
  lastAttemptAt: number;
  lastProgressAt?: number;   // resets on every progress-bearing attempt
  progress?: number;         // high-water mark of the durable progress counter
  workBaseline?: number;     // counter value when the incident opened
  oomAttempts?: number;      // attempts that ended in a memory-limit reset
};
```

The incident **identity deliberately excludes `recoveryKind`**
(`chatRecoveryIncidentId`, `recovery-incident.ts:263-273`) so a turn that flips
between retry and continue across restarts shares one budget.

### The five instruments (pure evaluation, `evaluateChatRecoveryIncident`, `recovery-incident.ts:653-816`)

- **Progress reset** — `madeProgress = currentProgress > existing.progress`
  where `currentProgress` is a **durable monotonic counter**
  (`cf:chat-recovery:progress`) bumped when a stream chunk is *durably flushed*
  (`_storeChunkDurably`), never recomputed from the compactable transcript
  (#1628). A progress-bearing redetection resets `attempt` to 1 and
  `lastProgressAt` to now. A deploy-interrupted-but-advancing turn therefore
  survives churn indefinitely.
- **Debounce** — redetections within `CHAT_RECOVERY_ALARM_DEBOUNCE_MS = 30s` do
  not bump `attempt` (one deploy rollout drops the socket several times).
- **STUCK (primary bound)** — `now - lastProgressAt >
  noProgressTimeoutMs` (default 5 min) seals `no_progress_timeout`.
- **ALARM-LOOP (secondary)** — `attempt > maxAttempts` (default 10) catches a
  tight no-progress alarm loop.
- **RUNAWAY** — `progress - workBaseline > maxRecoveryWork` (default 1000)
  seals `work_budget_exceeded`. This exists because an OOM-ing turn streams a
  little "progress" before dying, which resets both progress-keyed bounds
  forever (#1825) — work only climbs.
- **OOM budget** — `oomAttempts > maxOomRetries` (default 3) seals
  `out_of_memory`. Bumped out-of-band by `recordOomAndDecide`
  (`recovery-engine.ts:719-756`) when a recovery callback observes a DO
  128MB memory-limit reset; unlike the attempt cap it **never resets on
  progress**.
- **CALLER** — optional `shouldKeepRecovering(ctx)` predicate (token/cost
  budgets); a throwing predicate is treated as "keep recovering".
- A turn parked on a pending **client interaction** (HITL approval, client
  tool) is **budget-free**: all bounds suppressed, `lastProgressAt` kept fresh.

Defaults (`recovery-incident.ts:135-206`):

```ts
DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS = 10
DEFAULT_CHAT_RECOVERY_MAX_WORK = 1000
DEFAULT_CHAT_RECOVERY_MAX_OOM_RETRIES = 3
DEFAULT_CHAT_RECOVERY_STABLE_TIMEOUT_MS = 10_000
CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS = 3
DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000
CHAT_RECOVERY_ALARM_DEBOUNCE_MS = 30 * 1000
CHAT_RECOVERY_INCIDENT_TTL_MS = 60 * 60 * 1000   // stale incidents swept
```

### What `stableTimeoutMs` measures

It is **not** a model or stream timeout. When a scheduled recovery callback
(`_chatRecoveryContinue` / `_chatRecoveryRetry`) fires, it first waits for the
agent to reach a *stable* state — turn queue idle, no pending client
interaction, no armed auto-continuation — via `waitUntilStable({ timeout:
recoveryConfig.stableTimeoutMs })` (`think.ts:13712-13774, 15073-15076`). If
the agent hasn't stabilized within `stableTimeoutMs` (default 10s — e.g.
another deploy is churning, or a turn is mid-flight):

1. **Park** if a client interaction is pending (waiting on the human is not
   churn — stop retrying, clear the "recovering…" flag, let the client's replay
   resume the turn; `think.ts:15077-15088`).
2. Otherwise **reschedule** within the same attempt budget:
   `rescheduleAfterStableTimeout` bumps `attempt`, and issues a **delayed,
   deliberately NON-idempotent** schedule (3s) — non-idempotent because the
   currently-executing one-shot schedule row is deleted by `alarm()` only after
   the callback returns, so an idempotent reschedule would dedupe onto the
   doomed row and never fire (`recovery-engine.ts:36-53, 666-695`).
3. When the budget is spent, **terminalize** through the same exhaustion path
   as everything else.

### Exhaustion (`onExhausted`, terminal message)

`exhaustRecoveryGiveUp` (`recovery-engine.ts:795-874`) is the give-up
choreography: read the stored incident (re-entry guard: `status ===
"exhausted"` means a duplicate stale alarm — return), synthesize a minimal
incident if the record is gone (so the turn *still* terminalizes instead of
vanishing), resolve the orphaned stream partial, and run
`runChatRecoveryExhaustion` (`recovery-engine.ts:1026-1056`) which:

- emits `chat:recovery:exhausted`,
- invokes the user's `onExhausted(ctx)` (a throwing hook is swallowed — it can
  never block terminal delivery, a tested invariant),
- then runs the host's terminal writes: broadcast the configured
  `terminalMessage` banner *first* (so it survives a storage write rejecting
  mid-deploy), write the durable terminal record (`cf:chat:last-terminal`,
  replayed to reconnecting clients), and (Think) mark the running submission
  row `error`.
- A `terminalize` that throws **propagates deliberately** so the schedule row is
  deferred and the whole give-up re-runs on a healthy isolate (#1730); the
  seal write happens after, so at most one duplicate banner.

### How a crash-looping fiber doesn't burn the DO forever

Three independent mechanisms:

- **Recovery-alarm backoff**: the wake scan tracks `_recoveryNoProgressScans`;
  `_scheduleNextAlarm` arms the recovery alarm at
  `min(5min, keepAliveIntervalMs * 2^scans)` (`index.ts:1011-1021,
  6544-6557`) so a poison hook doesn't wake the DO every 30s forever.
- **Max age**: unmanaged orphan rows older than `fiberRecoveryMaxAgeMs` (24h)
  are dropped.
- **OOM circuit breaker at the alarm boundary** (#1825): `alarm()` wraps its
  body, intercepts only memory-limit resets (which the platform would otherwise
  auto-retry forever = OOM crash loop), tracks a durable strike counter, purges
  the exact looping schedule row, and seals active incidents when the in-DO
  budgets couldn't (`index.ts:6612-6630`).

---

## 3. Turn recovery in Think

### What is snapshotted

Two complementary durable artifacts:

1. **The chat fiber snapshot** — written as the fiber's `initialSnapshot` when
   the turn starts. Every model turn (WS, RPC `chat()`, programmatic) is
   wrapped when `chatRecovery` is enabled (`think.ts:4430-4458, 7442-7446`):

```ts
const snapshot = createChatFiberSnapshot({
  kind: "think-chat-turn",
  requestId,
  recoveryRootRequestId: this._activeChatRecoveryRootRequestId ?? requestId,
  continuation,
  messages: this.messages,          // only latest ids/roles are derived
  lastBody: this._lastBody,
  lastClientTools: this._lastClientTools
});
return this._runFiberWithStashWrapper(
  `${Think.CHAT_FIBER_NAME}:${requestId}`, async () => fn(), {
    initialSnapshot: wrapChatFiberSnapshot("__cfThinkChatFiberSnapshot", snapshot, null),
    wrapStash: (data) => wrapChatFiberSnapshot("__cfThinkChatFiberSnapshot", snapshot, data)
  });
```

   The snapshot shape (`packages/agents/src/chat/recovery.ts:17-29`) is tiny
   and deliberate: `requestId`, `recoveryRootRequestId`, `continuation`,
   `latestMessageId/Role`, `latestUserMessageId`, `startedAt`, `lastBody`,
   `lastClientTools`. **No buffered chunks, no partial text** — those live in
   the stream store.

2. **Durably persisted stream chunks** — every streamed chunk is flushed to
   `cf_ai_chat_stream_chunks` (+ a `cf_ai_chat_stream_metadata` row with
   `status: streaming|completed|error` keyed by `request_id`) via
   `_storeChunkDurably` (`think.ts:12463`), which also bumps the recovery
   progress counter. On recovery, the orphaned partial (accumulated text +
   parts + `hasSettledToolResults`) is reconstructed by replaying stored chunks
   through the AI-SDK codec (`think.ts:15207-15215`).

### Resume vs retry vs notice — the decision

On wake, `_handleInternalFiberRecovery` (`think.ts:14178-14235`) binds Think's
hooks into the shared engine lifecycle (gate on the `__cf_internal_chat_turn:`
fiber-name prefix → unwrap snapshot → resolve stream → reconstruct partial →
classify → open incident → …).

**Classification** (`_classifyRecoveredThinkTurn` + `_recoverablePreStreamUserId`,
`think.ts:14282-14300, 14432-14453`):

- **`retry`** (re-run the *user* turn) iff the eviction was **pre-stream**: the
  snapshot is not a continuation, records a `latestUserMessageId`, there is
  **no stream row and no partial**, and that user message is still the session
  leaf. Payload carries `targetUserId` so a superseded conversation skips.
- **`continue`** (finish the *assistant* turn) otherwise — some partial exists.
  Payload carries `targetAssistantId` (the persisted-partial leaf) so a stale
  continuation skips when the leaf moved.
- **Terminal stream** (`completed`/`error` metadata): never retried or
  continued; dispatch only reconciles the durable submission
  (`think.ts:14345-14354`).

Before dispatch, the engine persists the orphaned partial into a real assistant
message (`persistOrphanedStream`) — gated so settled (non-idempotent) tool
results are **never dropped even when the budget is already exhausted or the
user hook says `persist: false`** (#1631, `recovery-engine.ts:455-482,
552-569`) — and completes the still-active stream row.

Dispatch then schedules `_chatRecoveryRetry` or `_chatRecoveryContinue` via
`schedule(0, callback, data, { idempotent: true })` (idempotent so a deploy
storm's repeated detections collapse into one row; `recovery-engine.ts:85-89`).
The callbacks themselves (`think.ts:14806-14954, 15048-15191`) wait for stable
state, re-check the session leaf (skip benignly with `conversation_changed` /
`no_unanswered_user_message` if superseded), restore `_lastBody` /
`_lastClientTools` from the payload, and re-enter the normal turn machinery
(`_retryLastUserTurn` / `continueLastTurn`) — which runs the transcript-repair
pass below and prompts the model to continue from the persisted partial.

The **interruption notice** case is exhaustion (section 2): the configured
`terminalMessage` banner + `onExhausted` + durable terminal record. There is
also a **same-isolate stall watchdog** that routes a stalled live stream into
the same bounded machinery (`_routeStallToBoundedRecovery`,
`think.ts:14113-14176`) — so a stall, a deploy, and an OOM all converge on one
budget.

### Delivery states `accepted` / `streaming` / `completed`

These belong to **messenger delivery** (external chat surfaces — Telegram,
Slack), not the core turn. Each messenger reply runs inside an idempotent
managed fiber (`think:messenger-reply`) whose stash is advanced through stages
(`packages/think/src/messengers/delivery.ts:201-292`):

```ts
export type MessengerReplyStage = "accepted" | "streaming" | "completed";

export function messengerReplyRecoveryMode(snapshot) {
  if (snapshot.stage === "accepted") return "answer";     // replay the turn — nothing visible yet
  if (snapshot.stage === "streaming") return "apologize"; // visible partial — post interruption notice
  return null;                                             // completed — nothing to do
}
```

The stage gates replay-vs-notice on **external visibility**: pre-visible work
is safely re-run; once anything was posted/streamed to the external surface,
recovery posts the configured interruption message instead of risking a
duplicate partial answer (`docs/think/messengers.md:173-187`).

---

## 4. Interrupted tool calls: transcript repair

Shared, pure implementation in
`packages/agents/src/chat/repair-transcript.ts:107-204`; Think wires it in
`_repairTranscriptForProvider` (`think.ts:3226-3253`), which runs **before
every provider call** on a recovered/continued turn — `continueLastTurn` builds
its history through it (`think.ts:5305`).

Detection: any `tool-*` / `dynamic-tool` part with a `toolCallId` and **no
settled result** — where settled means `output`/`result` present or state in
`output-available | output-error | output-denied`
(`toolPartHasSettledResult`, `repair-transcript.ts:35-45`).

Three carve-outs are kept verbatim:

- `state === "approval-responded"` — an approved server tool waiting for its
  continuation to run `execute()`; erroring it would strand the approval.
- Parts a host's `shouldRepair` declines (ai-chat skips parts still awaiting a
  *client* interaction the user may answer). Think repairs everything, using
  its hook to customize the shape instead.
- Settled parts (only their malformed `input` is normalized).

Everything else is normalized then handed to the overridable
`repairInterruptedToolPart`; the default (`think.ts:3198-3206`):

```ts
protected repairInterruptedToolPart(part) {
  return {
    ...part,
    state: "output-error",
    errorText: "The tool call was interrupted before a result was recorded."
  };
}
```

Rationale (file header): deleting the part would make the call "disappear" and
let the model silently re-run it; leaving it unsettled would make the next
provider call 400 with `AI_MissingToolResultsError`. Flipping it to an errored
result preserves the record and lets the model decide whether to re-try the
tool. Repaired messages are persisted back to the session, the cache replaced,
and `chat:transcript:repaired` emitted.

A closely related invariant lives in `waitUntilStable`'s pending-interaction
predicate (`think.ts:13804-13829`): a **server** tool's `input-available`
orphan is *not* treated as a pending interaction (nothing will ever resolve it
after eviction — treating it as pending would wedge recovery into burning its
whole budget on timeouts); it converges to `continueLastTurn`, where repair
errors it. A **client** tool's orphan *is* pending, because the SPA can replay
the `tool-result` after reconnect. Sub-agent RPC client tools are deliberately
**not persisted** into `_lastClientTools` for the same reason — the parent's
executor ref dies with the isolate, so they must recover like server tools
(`think.ts:7323-7338`).

---

## 5. Turn admission and idempotency (Think submissions + turn queue)

### Storage schema

`think.ts:9501-9531`:

```sql
CREATE TABLE IF NOT EXISTS cf_think_submissions (
  submission_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  request_id TEXT,
  stream_id TEXT,
  status TEXT NOT NULL,          -- pending|running|completed|aborted|skipped|error
  messages_json TEXT NOT NULL,   -- the turn input, held OUT of the session until claim
  metadata_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  messages_applied_at INTEGER,   -- when the input was appended to the session
  started_at INTEGER,
  completed_at INTEGER
)
```

### `submitMessages` (durable acceptance)

`think.ts:10115-10216`. Idempotency identical in shape to `startFiber`: lookup
by `submissionId` and/or `idempotencyKey`; conflicting identities throw; an
existing row returns `{ ...inspection, accepted: false }` (re-kicking the drain
if still pending); otherwise a `'pending'` row is inserted and a drain
scheduled. Crucially, **messages are stored in the ledger, not the session** —
they are appended to the conversation only when the submission's own turn
starts (`onMessagesApplied` stamps `messages_applied_at`;
`docs/think/programmatic-submissions.md:115-127`), preserving FIFO visibility.

### The drain and the turn queue

`_scheduleSubmissionDrain` → `schedule(0, "_drainThinkSubmissions", undefined,
{ idempotent: true })` (`think.ts:10218-10222`) — the drain rides the **alarm**,
so pending submissions survive eviction and are picked up on any wake
(additionally `_recoverSubmissionsOnStart` runs in `onStart`, `think.ts:3055`).
The drain loop claims the oldest `'pending'` row, flips it to `'running'`
(guarded `WHERE status = 'pending'`), and executes it as a turn
(`think.ts:10239-10384`).

All turns — WS messages, RPC `chat()`, programmatic, recovery continuations,
submissions — pass through `_admitTurn` (`think.ts:7137-7191`), which enqueues
onto a single in-memory `TurnQueue` wrapped in `keepAliveWhile`:

```ts
return this.keepAliveWhile(async () => {
  const turnPromise = this._turnQueue.enqueue(
    spec.requestId, () => this._runInsideAdmittedTurnBody(spec), ...);
  spec.onQueued?.();
  return turnPromise;
});
```

**Serialization** is the queue; **durability** is the submission ledger; the
queue itself is not persisted (safe, because everything durable re-enqueues
from its own ledger/schedule on wake).

### Deadlock prevention (blocking-mode nesting)

Two mechanisms:

- **Detection**: `_assertNotInsideAdmittedTurn` (`think.ts:7176-7178,
  7193-7198`) uses an `AsyncLocalStorage` turn context to *throw* when a
  blocking admission (`saveMessages`, `runTurn({mode:"wait"})`,
  `continueLastTurn`) is called from inside an active turn (a tool `execute`,
  a hook) — that call would await a queue whose head is itself:

```ts
throw new Error(`Think turn admission (${trigger}) cannot be called from inside
an active turn; use runTurn({ mode: "submit" }) or addMessages() instead`);
```

- **Escape hatches**: `submit` mode only *inserts a row* and returns — the
  drain runs the turn after the current one frees the queue. The drain's own
  execution passes `allowNested: true` because the alarm-owned drain can
  inherit a turn's ALS context; it is safe since "nothing holding the turn
  queue ever awaits this turn" (`think.ts:10302-10309`). `addMessages` /
  `_hostSendMessage` append directly to the session, bypassing the queue
  (`think.ts:7115-7127`).

### Crash recovery of the ledger (`_recoverSubmissionsOnStart`, `think.ts:10423-10505`)

For each `'running'` row on wake:

- `messages_applied_at IS NULL` **and** no message ids in the session → the
  turn never touched the conversation → safely reset to `'pending'` (re-run).
- Messages partially/fully applied and **no recovery evidence** → `'error'`
  ("interrupted after messages were applied") — never blind-re-run a turn whose
  input is already in the transcript.
- Applied but a **fresh chat fiber row / streaming stream row / scheduled
  `_chatRecoveryContinue` payload references it** → leave it `'running'`; the
  chat-recovery chain (keyed by the recovery-root request id, stable across
  chained continuations) will complete/fail it via
  `_completeRecoveredSubmission`.

---

## 6. Alarms: multiplexing one slot

The DO has one alarm. `_scheduleNextAlarm` (`index.ts:6462-6575`) recomputes it
from persistent + in-memory state after every mutation (schedule CRUD, keepAlive
acquire/release, alarm run):

```
nextTimeMs = min of:
  ├─ earliest ready cf_agents_schedules row (incl. overdue rows — SQLite
  │    survives restart, the armed alarm does not)
  ├─ earliest hung-interval recheck (running interval rows re-checked after
  │    hungScheduleTimeoutSeconds)
  ├─ now + keepAliveIntervalMs           (if _keepAliveRefs > 0; default 30s)
  ├─ now + min(5min, keepAlive * 2^noProgressScans)   (if orphaned fiber rows /
  │    stuck ledger rows exist — the recovery re-entry alarm, with backoff)
  └─ now + keepAliveIntervalMs           (if any facet-run index rows exist)
none of the above → deleteAlarm()
```

`alarm()` (`index.ts:6599-6788`) does, in order: pending-destroy pre-emption →
OOM circuit breaker wrapper → `super.alarm()` (PartyServer init → **`onStart`**,
so alarm wakes also run the wake-scan) → execute all due schedule rows
(interval rows get `running=1`/`execution_started_at` overlap protection; hung
ones force-reset; one-shot rows deleted after execution — which is what makes
the in-callback reschedule trick in §2 necessary) → `_onAlarmHousekeeping()`
(fiber + facet recovery scans) → `_scheduleNextAlarm()`.

**Who re-arms:** every writer re-arms after writing (all `schedule*`/`cancel`
paths call `_scheduleNextAlarm`, `keepAlive()` arms on 0→1 and re-computes on
1→0 via `ctx.waitUntil`), and the alarm handler itself always re-arms at the
end. `keepAlive` is invisible to `listSchedules()` — no rows, purely a factor
in the min computation.

The fiber-recovery term is the piece that makes recovery **self-driving**: an
orphaned run row with no clients still forces a future alarm, and the alarm
runs the scan. Chat recovery then rides ordinary schedule rows
(`_chatRecoveryContinue` / `_chatRecoveryRetry` callbacks), so it inherits the
same multiplexing.

---

## 7. Long turns vs platform limits

The doc states the threat model plainly (`docs/agents/durable-execution.md:36-48`):
eviction from (1) inactivity ~70–140s, (2) code deploys 1–2×/day, (3) alarm
handler 15-minute limit. Their strategy is **not** to prevent eviction
absolutely but to make it cheap:

- **`keepAlive()` while any work is in flight.** Every fiber holds a ref
  (`index.ts:5687`); every Think turn runs inside `keepAliveWhile`
  (`think.ts:7180`). The 30s alarm heartbeat resets the inactivity timer, so a
  multi-minute model stream is not idle-evicted. This is also the
  **hibernation answer**: with the WebSocket hibernation API, open sockets do
  not keep the isolate alive — the keepAlive *alarm* does, and it needs no
  socket at all. Nothing "keeps a turn alive across hibernation" in-memory;
  instead, everything needed to resume is durable and the alarm guarantees a
  wake.
- **Checkpoint + persist continuously, not at step boundaries only.** Stream
  chunks are flushed to SQLite as they arrive (`_storeChunkDurably`), tool
  results settle into the persisted transcript, `stash()` snapshots
  intermediate fiber state synchronously. A kill at any point loses at most the
  un-flushed tail of the current model call.
- **Re-enter by alarm, not by hoping the caller retries.** Recovery
  continuations are `schedule(0, ...)` rows; the drain is a schedule row;
  fiber recovery arms its own alarm. `ctx.waitUntil` appears only for small
  fire-and-forget cleanup (e.g. re-arming the alarm after a keepAlive dispose,
  `index.ts:4843-4852`), never as the durability mechanism.
- **The model call itself is the unit of loss.** They do not chunk a single
  LLM stream across invocations; if it dies, recovery re-prompts with the
  persisted partial (continue) or re-runs the user turn (retry), bounded by the
  incident budget.
- **Don't stay alive for external waits.** For hours-long operations the
  documented pattern is start job → persist job id → let the DO hibernate →
  wake on webhook/schedule (`docs/agents/long-running-agents.md:262-300`);
  Workflows for multi-step orchestration.
- **The 15-minute alarm limit** is treated as an eviction cause like any other
  (fibers running inside an alarm invocation get interrupted and recovered);
  the scan itself has a soft deadline (`fiberRecoveryScanDeadlineMs = 10s`)
  and yields to a follow-up alarm rather than overrunning.
- **OOM (128MB)** gets the dedicated circuit breaker + tight retry budget (§2).

---

## 8. Sub-agent RPC durability

Two layers: what the **parent** persists about the call, and how either side's
eviction resolves.

### The parent-side run ledger

`cf_agent_tool_runs` (`index.ts:2202-2244`): one row per dispatched child run —
`run_id`, `parent_tool_call_id`, `agent_type`, `status`
(`starting|running|...terminal`), `output_json`, `interrupted_reason`,
`child_still_running`, `detached` columns, plus durable chunk storage for the
child's forwarded stream so reconnecting clients replay it
(`_replayAgentToolRuns`, `index.ts:10141-10212`).

### Parent evicted while awaiting `chat()`

The in-memory `await` is gone forever (same rule as inline `runFiber`:
"If the DO is evicted during an inline await, the caller is gone",
`docs/agents/durable-execution.md:391`). On the parent's next wake, `onStart`
collects non-detached `starting|running` rows and `_reconcileAgentToolRuns`
(`index.ts:10214+`) resolves each one:

1. **Inspect the child** (`inspectAgentToolRun(run_id)`) — the child's own
   ledger is authoritative. Already terminal → collect the result, persist it,
   broadcast the terminal frame, and resume the parent turn.
2. **Child still running** → **re-attach**: `_reattachAgentToolRunToTerminal`
   (`index.ts:9973-10139`) tails the child's chunk stream from the last stored
   sequence (no duplicates) and follows it to terminal.
3. The child's persisted recovery incidents are consulted to classify it
   (`classifyAgentToolChildRecovery`, `recovery-incident.ts:354-374`):
   `in-progress` (still recovering — keep waiting) beats `failed` beats `none`,
   so "a parent never gives up on a child that is still recovering."

### Why the parent's wait can't hang forever

The re-attach wait is **progress-keyed with a re-arm loop**, exactly like the
chat budget (`index.ts:9950-9971`):

> The wait is PROGRESS-KEYED, not a flat wall clock … `noProgressTimeoutMs`
> bounds how long the parent waits with NO forward progress; it is reset on
> every forwarded chunk. … The loop also RE-ARMS across stream-closes (a child
> re-evicted mid-recovery …) as long as the prior attempt made progress … A
> genuinely silent/hung child can never block recovery forever: it seals
> `interrupted` after one `noProgressTimeoutMs` window.

An optional `maxWindowMs` hard ceiling additionally bounds a
forever-progressing child. On sealing, the row is marked `interrupted` with a
typed reason (`no-progress` / `window-exceeded` / `not-tailable`) and
`child_still_running` so the UI can distinguish "we stopped watching" from "it
died". The abort signal is deliberately **not** forwarded across the RPC — the
child keeps advancing to its own terminal so a *later* inspect can still
collect it.

### Child evicted mid-`chat()`

The parent's live RPC stream throws/closes; the same re-attach path handles it
inline (`index.ts:8216-8250`). Meanwhile the child recovers **itself** through
the ordinary chat-fiber machinery (its fiber row, its incidents, its alarm —
facets route through the root's alarm via the facet-run index). When a
recovered child turn settles outside the normal finalizer, it eagerly
reconciles its own stale child-run rows so a re-attached parent collects the
terminal immediately instead of waiting out a no-progress window
(`_reconcileOwnStaleAgentToolChildRuns`, `think.ts:14946-14952`).

**Detached runs** (fire-and-forget children) are excluded from the awaited
reconcile — a lost observer is their normal state; a durable
`detached_on_finish` parent method name (schedule-like, eviction-surviving) is
invoked on terminal instead (`index.ts:2238-2244, 10246-10253`).

---

## Mechanics worth stealing for an Effect-based DO kernel

Our kernel (`packages/alchemy/src/Cloudflare/AI/KernelCloudflare.ts`) already
persists the thread, inbox rows, and reminders, and serializes bursts through a
one-permit gate. Its gaps, restated against their model: (a) **nothing
re-enters the burst loop on wake** — a burst killed mid-round is simply gone
until the next dispatch; (b) the **in-flight round is invisible** — drained
inbox rows are deleted before the round's messages are appended, so an eviction
between drain and append *loses inputs*; (c) **waiters are in-memory
Deferreds** — acceptable per-v1, but there is no durable record that a dispatch
was accepted, so a caller that times out cannot distinguish lost vs running;
(d) **no attempt bounding** — a poison input that crashes the burst would be
retried (if we add re-entry) forever.

What to take, in priority order — all of it host-mechanical, none of it
Think's product policy:

1. **A liveness row per burst (their `cf_agents_runs`), written before the
   round, deleted after.** One row (`run:{roundSeq}` or a single `burst:live`
   key) with `created_at` and a JSON snapshot column. Insert it (synchronously,
   `transactionSync`-style) when a burst begins; delete when the burst goes
   quiescent. In Effect terms: `Effect.acquireRelease` around the burst body
   with a SQL insert/delete — but note **their delete is unconditional in
   `finally` while recovery is hook-driven**; do not try to make the release
   itself conditional.

2. **Stop deleting inbox rows before their effects are durable.** This is
   their single deepest invariant (submissions ledger: messages held in the
   ledger until `messages_applied_at`; claims are `UPDATE ... WHERE status =
   'pending'`). Concretely: mark inbox rows `claimed:{roundSeq}` at drain time
   and delete them only in the same `transactionSync` that appends the round's
   messages to the thread. On wake, `claimed` rows whose round row still exists
   are the crash evidence; their `messages-applied?` check (row ids present in
   the thread) decides re-queue vs mark-error. This makes the burst body
   idempotent at the round level without making the model call idempotent.

3. **A wake-scan invoked from every entry point.** Their trick is that
   `onStart` is framework-wrapped and the alarm calls it too, so *any*
   activation (RPC dispatch, alarm, HTTP) runs `_checkRunFibers` before user
   work. For us: a `recover` Effect that (i) scans for a live burst row with no
   in-memory burst, (ii) reconciles claimed inbox rows, (iii) kicks
   `state.waitUntil(burst)` if any inputs remain — run at DO class init /
   first-event, and from `alarm()`. Effect's layer memoization gives us a
   natural once-per-isolate hook; the important part is that **RPC `dispatch`
   must not be the only thing that can start a burst**.

4. **Self-arming recovery alarm.** Whenever the recovery scan leaves work
   pending (burst row present, inputs unprocessed), arm the alarm at
   `now + interval * 2^noProgressScans` capped at 5 min (their
   `_scheduleNextAlarm` fiber-recovery term, `index.ts:6544-6557`). Our alarm
   already re-arms from reminders; fold recovery into the same `min()` — one
   alarm slot, recomputed after every mutation, re-armed at the end of every
   `alarm()`.

5. **keepAlive as a ref-counted heartbeat folded into that same alarm.** While
   a burst is running, `min()` in `now + 30s`. This is what protects a
   multi-minute sampling from the ~70–140s idle eviction and is the only thing
   that keeps work alive across WebSocket hibernation. Trivial with our
   existing alarm plumbing: an in-memory ref count consulted by the arm
   computation, re-armed from the alarm handler while the count is > 0.

6. **A durable attempt/budget record, progress-keyed.** Steal the incident
   record shape wholesale (`attempt`, `maxAttempts`, `lastAttemptAt`,
   `lastProgressAt`, `progress`, `workBaseline`) plus the three decoupled
   instruments: a **durable monotonic progress counter** bumped when a round
   durably appends messages (never derived from the compactable thread), a
   **debounce** (~30s) so one deploy's reconnect storm is one attempt, and a
   **no-progress wall clock** (~5 min) as the primary seal with the attempt cap
   (~10) as backstop. On exhaustion, write a terminal note into the thread
   (their `terminalMessage` + `onExhausted` equivalent) and mark the run
   errored — visible, durable, never a silent drop and never an unbounded loop.
   Their OOM lesson (#1825) applies verbatim to us: a crash that streams a
   little progress before dying resets progress-keyed bounds, so keep a
   work-budget meter that only climbs.

7. **Transcript repair before every re-entry.** Before a recovered round
   samples the model, scan the thread tail for tool calls with no settled
   result and flip them to errored results in place (their
   `repairInterruptedToolParts`: keep the part, `state: output-error`,
   `errorText: "interrupted before a result was recorded"`). Never delete the
   call (the model would silently re-run it), never leave it unsettled (the
   provider 400s). Ours is simpler than theirs: no client tools and no HITL
   approvals yet, so no carve-outs — every unsettled call at recovery time is
   dead by definition (its Effect died with the isolate).

8. **Durable acceptance for `dispatch` (their `startFiber`/`submitMessages`
   shape) — when we need it.** Keep the in-memory Deferred for the fast path,
   but write an acceptance row `{id, idempotency_key UNIQUE, status, created_at,
   completed_at, output_json}` before kicking the burst, and complete it when
   the round answers. Duplicate keys return the existing row
   (`accepted: false`). This is what makes caller retries safe across our
   "waiter died with the isolate" gap — the retry joins or reads instead of
   double-enqueueing. The reply-vs-notice split can wait; the two-state ledger
   (accepted / completed) is the load-bearing part, and it also gives parents a
   `dispatch`-then-poll option that cannot hang on our RPC.

9. **For parent↔child dispatch later: progress-keyed re-attach, not wall-clock
   timeouts.** When a parent awaits a child and either side is evicted, resolve
   from the child's durable ledger (inspect → already-terminal? collect), tail
   from the last stored sequence, reset the wait budget on every forwarded
   chunk, re-arm across clean stream-closes that made progress, and seal
   `interrupted` after one silent window. Never propagate the parent's abort
   into the child — let the child reach its own terminal so a later inspect
   collects it.

**Deliberately NOT worth stealing** (Think product policy, orthogonal to the
kernel): the AI-SDK chunk vocabulary and stream store, the retry-vs-continue
classification (ours re-enters one burst loop; we don't distinguish user-turn
vs assistant-turn replay), WebSocket resume handshakes and the "recovering…"
client flag, sessions/compaction/leaf targeting, HITL parking
(`awaitingClientInteraction`) and client-tool carve-outs, messenger delivery
stages, and the facet/sub-agent alarm routing (until we grow facets, every run
owns its own DO and alarm slot).

The essence in one sentence: **write a row before you start, checkpoint into it
synchronously, delete it when you finish, scan for it on every wake from both
entry points, keep one self-re-arming alarm so a wake always comes, and bound
re-entry with a progress-keyed durable budget that terminalizes visibly.**
