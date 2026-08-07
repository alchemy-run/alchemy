# Driver Assembly: Decomposing the AI Drivers into a Core + Layers

Design for decomposing what exists today —
`src/AI/DriverMemory.ts` (~1,700 lines), `src/Cloudflare/AI/
DriverCloudflare.ts` (~1,600 lines), `src/AI/DriverShared.ts` (~370
lines) — into a **small core driver** plus **Layer-provided services**
whose default implementations ship with alchemy and whose real
implementations increasingly live in userland. The goal
([bootstrap.md](./bootstrap.md)): a self-improving agent must be able
to modify most of its own machine, so most of the machine must be
code it owns. Users ASSEMBLE their driver; alchemy ships the physics
and the defaults, not the personality.

Terminology note: the component previously called "the kernel" is now
**the driver** everywhere (code renamed 2026-08-07: `Driver`,
`DriverMemory`, `DriverCloudflare`, `DriverShared`, `RunObserver`,
`RunObservation`). "Kernel" survives only in dated research memos and
in quotes about other systems. [spec.md](./spec.md) prose still says
"kernel" throughout — sweeping it is a pending follow-up.

---

## 1. Evidence

- **pi / Prime Agent**: the core loop is ~990 lines behind four host
  hooks; everything users experience as "the agent" (retry,
  compaction, goals, autonomous gates, heartbeats, refine, sessions,
  daemon) is host code outside the loop. The loop never changes; the
  host churns weekly. Prime Agent then makes the HARNESS user-mutable
  but the loop stays frozen in someone else's repo — the ceiling we
  are explicitly building past.
- **Our duplication**: DriverMemory and DriverCloudflare implement the
  same algorithm twice, sharing only DriverShared. Every semantic
  change this week (crash model, quiet delivery, malformed-call
  feedback, run journal) was written twice or risked drift. Unweaving
  substrate from semantics IS this decomposition.

## 2. The reframing: a ROUND, not a loop

The deepest substrate difference is who owns the `while (true)`.
DriverMemory parks a fiber on a queue forever; DriverCloudflare can't
(isolates evict) and runs bursts per alarm/request; a workflow would
journal steps. The algorithm itself is ONE ROUND:

```
round(run):
  items    ← Mailbox.drain(run)                  # inputs + waiters + quiet
  boundary ← apply pending compaction; deliver notes
  tick     ← evaluate TURN (level-triggered stance render)
  toolkit  ← StanceCompiler.compile(stance)      # mention-is-presence
  sample*  ← Sampler.step(prompt, toolkit)       # inner agentic loop
  append   ← ThreadStore += inputs + response; emit observations
  quiesce  → return (the HOST decides what happens next)
```

The core driver owns `round` and the run-state machine around it
(admit, init-once-per-run, waiters, settle, crash delivery,
supervision cascade). It does NOT own the loop:

- **LocalHost** wraps `round` in a forever fiber parked on the mailbox.
- **DurableHost** runs `round` per alarm/request burst.
- **WorkflowHost** (future) journals each round as a step.

Because the HOST layer is user-assemblable, "what happens at park",
budgets, continuation policies, human-approval gates — everything a
governor would want — is ordinary user code in the user's host layer.
**There is deliberately NO core policy hook for oversight**: the
human-governor machinery ([bootstrap.md](./bootstrap.md) mission
section) is built in userland, where it belongs. pi needs continuation
hooks because its loop is closed; ours is a layer the user owns.

## 3. The decomposition, file by file

| Today | Becomes | Ships in alchemy | Userland swaps |
|---|---|---|---|
| the round body in BOTH drivers + run-state machine | **`Driver` core** (~400–500 lines, zero substrate imports, written only against the services below) | yes — stable, boring on purpose | forkable, but shouldn't need it |
| `Queue` inbox/quiet/wake (Memory) vs storage+alarm bursts (Cloudflare) | **`Mailbox`** service | memory + DO layers | queues (SQS etc.) for serverless |
| `run.prompt` + compaction apply (+ RunJournal snapshots) | **`ThreadStore`** service | memory + DO layers | sqlite (org's, exists) |
| `remind` on fibers vs DO alarms | **`Clock`** service | fiber + DO layers | cron, external schedulers |
| `step` — streamText, part accumulation, retry, malformed-call feedback | **`Sampler`** service | default = today's behavior | retry/budget/tiering policy lives INSIDE the user's Sampler layer — no separate "policy" object |
| `actorTick` stance→toolkit compilation, skill-graph fixpoint, spawn/dispatch/skill intrinsics, DriverShared compile helpers | **`StanceCompiler`** service | default = today's mention-is-presence semantics; intrinsics are part of its contract | add intrinsics (`remind_me`, `note_lesson`, `reload`), remove `spawn`, custom wire packs |
| run sockets + `AgentGateway` | a layer over the run registry | yes | custom transports |
| `DriverMemory` | **`LocalHost`** = Driver + memory layers + forever-loop (~200 lines) | yes | the org's own host: park/continue/budget logic as plain code |
| `DriverCloudflare` | **`DurableHost`** = Driver + DO layers + burst (~1,200 duplicated lines deleted) | yes | — |
| existing seams (`RunObserver`, `WireMode`, `Chats`, `PersistentRef.Store`, `RunJournal`) | unchanged | yes | already swapped in the org (sqlite) |

What defines the split: the core owns the INVARIANTS —
waiters-ride-inputs, steer-at-the-sampling-boundary, level-triggered
stance, init-once, settle cascades, seq'd observations, typed crash
delivery. Services own everything with a legitimate second
implementation. If a change to the core is attractive, first ask
whether it is a service (or host) in disguise.

## 4. The user's driver

```ts
// services/alchemy-org/src/driver/Driver.ts — the coder's own machine
export const CoderDriver = AI.Driver.pipe(
  Layer.provide(AI.LocalHost),          // or the org's own host with its own park/continue logic
  Layer.provide(OrgSampler),            // ./Sampler.ts   — retries, budgets, model tiers
  Layer.provide(OrgStanceCompiler),     // ./Stance.ts    — + remind_me, note_lesson intrinsics
  Layer.provide(Stores),                // sqlite chats/journal/refs (already org-authored)
);
```

Every file but the core is in the agent's repository —
hot-reloadable by the bootstrap loop, reviewable by the operator.
`Driver` (the interpret service) remains the ultimate escape hatch: the
whole core is just its default implementation, so a user who outgrows
the invariants writes their own interpret and still speaks the L0
contracts (terms, observations, sockets, chats) that keep ecosystems
interoperable.

## 5. Migration

1. **`Sampler` + `StanceCompiler`** — the two biggest self-contained
   chunks, extractable from both drivers with tests staying green.
   The malformed-call feedback and retry policy move INTO the default
   Sampler; DriverShared's compile helpers move into the default
   StanceCompiler.
2. **`Mailbox` + `ThreadStore` + `Clock`** — the substrate plane;
   `src/AI/Driver.ts` core is born; DriverMemory collapses into
   `Driver + LocalHost`.
3. **Re-base DriverCloudflare** as `Driver + DurableHost` — the
   validation gate: if the DO host needs a core change, the seam was
   wrong; fix the seam. ~1,200 duplicated lines die here.
4. **The org assembles its own driver** (`services/alchemy-org/src/
   driver/`) — initially re-exports of the defaults, diverging by the
   agent editing its own layers (bootstrap.md's loop now covers driver
   policy).
5. **Serverless/workflow host** when a real use arrives — the
   round-not-loop shape guarantees it fits.

## 6. Open questions

- **Contract stability**: service contracts are public API once user
  drivers exist. Proposal: `@experimental` until the DO re-base
  (step 3) proves them, then frozen like the term language.
- **ThreadStore vs RunJournal**: a first-class ThreadStore could make
  appends durable incrementally and subsume the snapshot journal.
  Decide during step 2; bias toward keeping RunJournal as the
  snapshot/restore contract.
- **Intrinsic removal vs supervision invariants**: removable
  intrinsics interact with the cascade contract — likely "removable,
  but the cascade semantics stay" (a driver without spawn simply never
  has children).
- **spec.md terminology sweep** (kernel → driver) — pending; the spec
  is the contract document and should follow the code's vocabulary.
