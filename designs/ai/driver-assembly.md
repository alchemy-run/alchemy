# Driver Assembly: One Engine, Placements, Storage as Layers

Status: **implemented** (2026-08-08). This document describes the
architecture as it exists in code.

The goal ([bootstrap.md](./bootstrap.md)): a self-improving agent must
be able to modify most of its own machine, so most of the machine must
be code it owns. Users ASSEMBLE their driver; alchemy ships the
algorithm and the defaults, not the personality.

## Vocabulary (agreed)

- **Session** — one keyed conversation instance of an agent
  (`term/key`): its thread, lifecycle, observation log. ("Run" is
  retired.)
- **Round** — one drain-to-quiescence cycle within a session.
- **Tick** — one sampling within a round.
- **Burst** — run rounds until the session parks or settles; the unit
  of execution on every substrate (`engine.burst(key)`).
- **Driver** — the contract: `interpret(term, charter) → Actor`.
- **Placement** — where sessions physically live and how bursts are
  driven: `DriverLocal` (resident fibers) or `DriverCloudflare`
  (Durable Objects).

## `DriverCore` — the whole machine, written once

`src/AI/DriverCore.ts` contains everything substrate-independent:

**The algorithm** — `compileTick` (turn → stance → skill-graph
fixpoint → doors/dispatch/spawn/skill intrinsics → toolkit, through
the optional `ToolEngine` seam) and `sampleTick` (thread →
`LanguageModel.streamText` → live parts → response append + observations, malformed
feedback).

**The session engine** — `makeSessionEngine(options)`: the complete
lifecycle, written once for every placement — admit (with
init-once-per-shell), the inbox drain with waiter pairing (a dispatch
waiter joins a round only when its own input's seq is drained), quiet
inputs (never open a round; join whichever round drains), compaction
at the boundary, the burst loop, crash triage (deterministic failures
abandon the round and fail waiters TYPED; transient ones leave the
round owed to a scheduled re-entry), bounded busy/liveness recovery
with visible abandonment, settle with the supervision cascade and a
persisted outcome for late dispatches, spawn (the call itself drives
the anonymous worker's rounds — works on every substrate), and
restore. A burst is TOTALLY contained: it never rejects, because
placements often run it on fire-and-forget channels (a rejected
`waitUntil` promise resets a Durable Object).

The engine consumes:

| Seam | Contract |
|---|---|
| `ThreadStorage` | where session facts persist: messages, observation log, meta (tick/cursor/active/busy/settled), and the INBOX with `putInbox`/`listInbox`/`admit` — admit is the ATOMIC drain (messages + watermark + round-open in one write) |
| `LanguageModel` | one model call (effect/ai): streaming consolidation; retry/tiering wrap this Layer |
| `ToolEngine` | how mentions appear on the wire (direct tools vs codemode `eval`) |
| `EventStream` | lifecycle facts out (session index, boards, live tails) |
| `PersistentRef.Store` | charter refs, framed per session |

And a placement provides five callbacks: `kick` (trigger execution),
`broadcast` (socket fanout), `remind` (the clock), `scheduleReentry`
(recovery), and optionally `stateStore`/`wrapHandler`.

## The placements

**`DriverLocal`** (`src/AI/DriverLocal.ts`, ~280 lines) — resident:
one fiber per session that bursts then parks on a wake queue; sockets
are a RAM writer set served by `AgentGateway` on the host's own HTTP
server; `remind`/`scheduleReentry` are sleeping fibers; restore
happens at interpret and starts fibers when the Host program runs.

```ts
AI.DriverLocal.pipe(Layer.provide(AI.MemoryThreadStorage))          // ephemeral
AI.DriverLocal.pipe(Layer.provide(SqliteThreadStorage(".alchemy/runs.sqlite")))
```

With sqlite, the durable inbox + busy marker mean a killed process
redelivers pre-crash inputs and recovers interrupted rounds exactly
like Durable Objects — recovery is engine behavior, not a Cloudflare
feature.

**`DriverCloudflare` / `DurableObjectHost`**
(`src/Cloudflare/AI/DriverCloudflare.ts`, ~520 lines) — one DO per
session (named `${term}/${key}`): verbs as RPC, `kick` is
`state.waitUntil(burst)` (parking is returning), storage is
`DurableObjectThreadStorage` (the same `ThreadHandle` over the
instance's rows; spawn workers ride an in-memory sibling), broadcast
is hibernatable WebSockets re-read per frame, and ONE alarm serves
both clocks (reminder rows + recovery deadlines), fully contained so
workerd's alarm retry never races the engine's bounded recovery.

## Extension model

Wrap seams, never fork the engine:

```ts
export const OrgDriver = AI.DriverLocal.pipe(
  Layer.provide(SqliteThreadStorage(".alchemy/runs.sqlite")),
  Layer.provide(OrgModel),            // tiering/retry/budget policy
  Layer.provide(AI.CodeModeEffect()), // calling convention
);
```

A new substrate is a `ThreadStorage` implementation (+ a placement
only if it can't hold a resident fiber). There is deliberately NO
core policy hook for oversight: budgets, continuation policies,
approval gates are userland — wrap `LanguageModel`, wrap a tool, or write
your own placement.

## Verification

- `test/AI/DriverLocal.test.ts` + `SessionSocket.test.ts` +
  `DriverAnthropic.test.ts` — engine + resident placement, scripted
  model (38 tests, including quiet-send and crash semantics).
- `test/AI/ThreadStorage.test.ts` — the storage contract, one suite
  over memory AND sqlite (inbox, atomic admit, watermark, restore
  surface).
- `test/Cloudflare/AI/DriverCloudflare.test.ts` — the DO placement,
  live: durable threads, cross-DO delegation, alarm reminders, alarm
  recovery of interrupted rounds, poisoned-round abandonment, socket
  replay/deltas, settle (10 tests).
