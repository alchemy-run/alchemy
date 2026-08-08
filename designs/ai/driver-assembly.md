# Driver Assembly: One Algorithm, Substrate as Layers

Status: **implemented** (2026-08-08). This document describes the
architecture as it exists in code; the historical plan it replaced is
in git history.

The goal ([bootstrap.md](./bootstrap.md)): a self-improving agent must
be able to modify most of its own machine, so most of the machine must
be code it owns. Users ASSEMBLE their driver; alchemy ships the
algorithm and the defaults, not the personality.

## Vocabulary (agreed)

- **Session** — one keyed conversation instance of an agent
  (`term/key`): its thread, lifecycle, observation log. (The term
  "run" is retired.)
- **Round** — one drain-to-quiescence cycle within a session.
- **Tick** — one sampling within a round.
- **Driver** — the contract: `interpret(term, charter) → Actor`.
- **`DriverCore`** — the driver over the RESIDENT host (a forked
  fiber per session, parked on its inbox) consuming the seams below.
- **`DurableObjectHost` / `DriverCloudflare`** — the driver over the
  BURST host (event-kicked, serialized, alarm recovery) on Durable
  Objects.
- **Seams** — plain `Context.Service`s the algorithm consumes:
  `Model`, `ThreadStorage`, `ToolCalling`, `SessionObserver`,
  `PersistentRef.Store`, `AgentGateway`.

## The shared algorithm (written once)

`src/AI/DriverShared.ts` owns the algorithm, parameterized by
`SessionOps` — the small adapter each host implements (provide
session services, stamp observations, persist active skills, remember
children, spawn policy):

- **`compileTick(ops, resolvers, inputs)`** — evaluate the turn
  (function turns receive `{count, inputs}`), render the stance,
  walk the skill graph to its active fixpoint, build door/dispatch/
  spawn/skill intrinsics, present capabilities through the optional
  `ToolCalling` seam, assemble the toolkit.
- **`sampleTick({ops, model, handle, tick, exhausted})`** — read the
  thread from the `ThreadHandle`, call the `Model`, surface live
  parts, append the response (or the malformed-call corrective note)
  with its durable observations.
- **`makeResolvers(driver, term, context)`** — memoized capability
  resolution (tools, skills, delegate actors) from the charter's
  captured Layer context.

Nothing in the algorithm knows where it runs. The discipline that
makes this true: **every durable fact crosses one interface,
write-through** — each input, note, response row, observation, and
meta update lands in a `ThreadHandle` the moment it exists. The
algorithm keeps no private durable state, so it can be killed at any
line and re-entered (which is what a serverless substrate does).

## The two substrate seams

**1. `ThreadStorage` (`src/AI/ThreadStorage.ts`) — where facts live.**
`open(term, key) → ThreadHandle`, `keys(term)` (the restore surface),
`remove(term, key)` (settled sessions). The handle carries messages
(encoded rows), the observation log (seq-cursored), and
`SessionMeta` ({tick, observed, active}); `appendObservation` writes
row + cursor atomically. Implementations:

- `MemoryThreadStorage` (`src/AI/ThreadStorage.ts`) — Maps; as
  durable as the process.
- `SqliteThreadStorage` (`src/SQLite/ThreadStorage.ts`) — bun:sqlite;
  restart restores every unsettled session parked, thread primed,
  cursor continued.
- `makeDurableObjectSessionStorage`
  (`src/Cloudflare/AI/DurableObjectThreadStorage.ts`) — the same
  handle over one DO's rows (`msg:`/`obs:`/`meta`), plus the host-only
  facts (`inbox:` watermark, `remind:` rows, busy marker) as a
  superset meta.

**2. The host — how the loop is driven.** The one thing that can't be
a data contract:

- **Resident** (`DriverCore`): fiber per session, blocks parked on a
  RAM inbox; waiters are Deferreds; `remind` is a sleeping fiber;
  restore happens at interpret from `ThreadStorage.keys`.
- **Burst** (`DurableObjectHost`): no resident fiber; every event
  kicks a serialized burst that runs rounds until quiescence and
  RETURNS. Inbox rows + drain watermark give at-least-once drain /
  exactly-once append; a liveness marker + the DO alarm re-enter
  interrupted rounds (bounded attempts, then visible abandonment);
  `remind` is an alarm row; verbs arrive as RPC on the `AgentSessions`
  DO (one instance per session, named `${term}/${key}`).

## Assemblies

```ts
// ephemeral local
AI.DriverCore.pipe(Layer.provide(AI.MemoryThreadStorage))

// durable local (what alchemy-org runs)
AI.DriverCore.pipe(
  Layer.provide(SqliteThreadStorage(".alchemy/coder-runs.sqlite")),
  Layer.provide(OrgModel),
)

// cloudflare
Cloudflare.AI.DriverCloudflare   // = DurableObjectHost over DO storage
```

There is deliberately no `DriverMemory` export — compose explicitly.

## The seams users swap

| Seam | Decides | Default |
|---|---|---|
| `Model` | one model call: streaming consolidation, retry policy, malformed budget, tiering | `makeModel(LanguageModel)`, 3× exponential |
| `ThreadStorage` | where thread/observations/meta persist | chosen per assembly |
| `ToolCalling` | the calling convention: direct provider tools vs codemode's single `eval` (`CodeModeEffect`/`CodeModeAsync`) | direct |
| `SessionObserver` | where lifecycle facts flow (chat projections, boards) | absent |
| `PersistentRef.Store` | where charter refs persist (framed per session) | memory |
| `AgentGateway` | live view attach (WebSocket → replay + deltas) | provided by each host |

**There is deliberately NO core policy hook for oversight**: budgets,
continuation policies, human-approval gates are ordinary user code —
wrap `Model`, wrap a tool, or write your own host. pi needs
continuation hooks because its loop is closed; ours is a layer the
user owns.

## What stays host-specific (and why)

- Waiters (Deferreds) — process-shaped, not serializable. An eviction
  mid-round fails the DO caller, which re-drives from the world
  (durable continuations are a later phase).
- The DO inbox/watermark/busy machinery — burst-only concerns.
- `spawn` on the DO host — refused honestly (each anonymous worker
  would be its own DO session; later phase).

## Verification

- `test/AI/DriverCore.test.ts` + `SessionSocket.test.ts` — the
  algorithm + resident host, scripted model (30 tests).
- `test/Cloudflare/AI/DriverCloudflare.test.ts` — the burst host,
  live: durable threads, cross-DO delegation, alarm recovery,
  poisoned-round abandonment, socket replay/deltas (10 tests).
