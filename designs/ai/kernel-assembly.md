# Kernel Assembly: the Minimal Driver and the Hooks

Design for factoring the AI kernel into a **tiny, stable driver**
distributed with alchemy plus **Context.Service hooks** whose
implementations mostly live in userland — so that an agent like
`services/alchemy-org` assembles (and eventually EDITS) its own
kernel, layer by layer. Each user is bootstrapping their own AI; the
framework ships the physics and a set of defaults, not the personality
of the machine.

Companion to [bootstrap.md](./bootstrap.md) (the self-improvement
loop needs most kernel behavior in agent-editable code) and
[reports/prime-agent.md](./reports/prime-agent.md) (the evidence
base). Supersedes nothing in [spec.md](./spec.md) — this is the
implementation architecture FOR the spec's kernel contract.

---

## 1. The evidence

Three independent sources point at the same factoring:

- **pi (and Prime Agent on top of it)**: the core loop is ~990 lines
  and exposes FOUR host hooks — `shouldStopBeforeTurn`,
  `shouldStopAfterTurn`, `getSteeringMessages`/`getFollowUpMessages`,
  `getContinuationMessages`. Everything users experience as "the
  agent" — retry, compaction, goals, autonomous gates, heartbeats,
  refine, sessions, the daemon — lives OUTSIDE the loop, attached
  through those hooks in an 11k-line host. The loop is so small it
  never needs to change; the host churns weekly.
- **Prime Agent's limit**: it makes the HARNESS user-mutable (prompts,
  skills, memory as CRUD state) but the agent can never touch the
  loop, the scheduler, or the messaging semantics — those are frozen
  TypeScript in someone else's repo. Their own source concedes the
  design is interim (`TODO: reconsider whether the persistent kernel
  is needed once RLM-1 weights land`). Our ambition is strictly
  larger: the agent's kernel is source in ITS OWN repository, behind
  the same typecheck/review gates as everything else.
- **Our own duplication**: `KernelMemory` (1,691 lines) and
  `KernelCloudflare` (1,617 lines) implement the same algorithm twice,
  sharing only `KernelShared` (371 lines). Every semantic change this
  week (crash model, quiet delivery, malformed-call feedback, journal)
  was written twice or risked drift. Substrate concerns (queues vs
  alarms, fibers vs storage) are woven through semantics; unweaving
  them IS the driver/hook split.

## 2. The reframing that unlocks it: a ROUND, not a loop

The deepest substrate difference is not storage — it is **who owns the
`while (true)`**. KernelMemory parks a fiber on a queue forever;
KernelCloudflare cannot (isolates evict) and instead runs BURSTS per
alarm/request. The harness survey's law — *"every shipped perpetual
agent is a relay of bounded episodes over durable external state"* —
is a statement about hosts, not about the algorithm.

So the driver's unit is **one round**:

```
round(run):
  items    ← Mailbox.drain(run)                  # inputs + waiters + quiet
  boundary ← apply pending compaction; deliver notes
  tick     ← evaluate TURN (level-triggered stance render)
  toolkit  ← compile stance mentions (WireMode + Intrinsics)
  sample*  ← LanguageModel via SamplingPolicy    # inner agentic loop
  append   ← Thread += inputs + response; emit observations
  verdict  ← Governor.onQuiesce → CONTINUE (more work) | PARK
```

The driver owns `round` and the run-state machine around it (admit,
init-once-per-run, park, settle, crash, supervision cascade, waiter
semantics). It does NOT own the loop:

- **LocalHost** wraps `round` in a forever fiber parked on the mailbox.
- **DurableHost (DO)** runs `round` per alarm/request burst; parking =
  returning; waking = an alarm or delivery.
- **WorkflowHost (future)** journals each round as a step.

One algorithm, written once; "local vs server vs serverless vs durable
object" collapses into which ~200-line host wraps the same driver.

## 3. The five layers

```
L0  the LANGUAGE      terms & contracts (stable ABI)          alchemy, semver
L1  the DRIVER        round + run-state machine (~400 lines)  alchemy, boring on purpose
L2  the HOOKS         Context.Services with shipped defaults  alchemy defaults, userland overrides
L3  the HOSTS         loop ownership per substrate            alchemy (Local, DO), thin
L4  the USER KERNEL   the assembly, in the user's repo        alchemy-org — the self-improvement surface
```

**L0 — the language** (already exists, stays): `Agent`, `Tool`,
`Skill`, `Parameter`, `Event`, `Dispatch`, `prose`/`Fragment`, the
wire types, the `Actor` verbs, the `KernelObservation` vocabulary,
the UIMessage adapter, `RunSocket` protocol. This is the ecosystem's
ABI — like Smithy models for distilled: everything else is derived
from or checked against it. Userland renderers, stores, and policies
all type against L0, which is what keeps a thousand divergent user
kernels interoperable (boards, sockets, chats all still work).

**L1 — the driver**: the round function + run-state machine, written
once against the hook contracts, with NO substrate imports. Target
≤500 lines. Deliberately boring: if a change here is attractive, first
ask whether it is policy (L2) or host (L3) in disguise. The driver is
also where the spec's INVARIANTS live — waiters-ride-inputs, steer at
the sampling boundary, level-triggered stance, quiescence = park,
settle cascades — the things that make an alchemy agent an alchemy
agent regardless of whose kernel assembly runs it.

**L2 — the hooks** (§4): small in number (pi survives on four), each a
`Context.Service` with a shipped default layer.

**L3 — the hosts**: `KernelMemory` becomes `LocalHost` = driver +
{Mailbox=Queue, Clock=fibers, forever-loop} (its current sqlite seams
stay exactly as they are). `KernelCloudflare` becomes `DurableHost` =
driver + {Mailbox=DO storage+alarms, Clock=alarms, burst}. Both shrink
to substrate glue.

**L4 — the user kernel**: what alchemy-org owns. An assembly file the
AGENT can read and edit:

```ts
// services/alchemy-org/src/kernel/Kernel.ts — the coder's own kernel
export const CoderKernel = AI.Driver.pipe(
  Layer.provide(AI.LocalHost),               // forever-loop, fibers
  Layer.provide(Policies),                   // ./SamplingPolicy.ts (org-authored)
  Layer.provide(Governors),                  // ./Governor.ts (budgets, park rules)
  Layer.provide(Intrinsics),                 // ./Intrinsics.ts (skill/spawn/dispatch + remind + lessons…)
  Layer.provide(Stores),                     // sqlite chats/journal/refs (already org-authored!)
);
```

Every file but `AI.Driver` is in the agent's own repo, hot-reloadable
by the bootstrap loop, reviewable by the governor. The endgame from
bootstrap.md — "it can even make changes to the kernels" — stops being
scary: the DRIVER is the only shared piece, and even it is just a file
the mature org can vendor and fork.

## 4. The hook inventory

Guiding rule from the flue-2 analysis: alchemy rejected imperative
hook-soup — CONTENT customization is the stance (level-triggered
prose), never callbacks. These hooks are the CONTROL plane and the
SUBSTRATE plane only. Keep the count single-digit forever.

| Hook | Contract (essence) | Shipped default | Who overrides |
|---|---|---|---|
| `Mailbox` | `admit(run, item, {wake})`, `drain(run)`, `awaitWake(run)`; quiet + waiter semantics preserved by contract | in-memory Queue | DO storage+alarm; SQS/queue for serverless |
| `ThreadStore` | the prompt log: `read(run)`, `append(run, msgs)`, `replace(run, msgs)` (compaction apply) | in-memory (+ `RunJournal` snapshot, exists) | sqlite (org, exists), DO storage |
| `Clock` | `remind(run, delay, note)` — time as a wake source | fiber sleep | DO alarms; cron for serverless |
| `SamplingPolicy` | wraps the model step: retry schedule, malformed-call feedback, token/step budgets | today's behavior (retry retryables ×3, malformed ×3) | org: budgets, model tiers per phase, circuit breakers |
| `Governor` | boundary verdicts: `beforeRound(run) → Proceed \| Refuse(reason)`, `onQuiesce(run) → Park \| Continue(inputs)` | park-on-quiesce, always proceed | goals, autonomous gates, cost ceilings, rate limits — pi's four hooks live here |
| `Intrinsics` | always-on grants beyond the stance: `(run) → CompiledTools` | the `skill`/`spawn`/`dispatch` pack | org adds `remind_me`, `note_lesson`, `reload`; can also REMOVE (a kernel with no spawn) |
| `WireMode` | presentation of grants (exists) | direct tools | codemode Effect/async |
| `KernelObserver` | observation sink (exists) | none | Chats projection (exists) |
| `PersistentRef.Store` | run-scoped durable refs (exists) | memory | sqlite (exists), DO |
| `RunJournal` | thread durability + restore (exists) | none | sqlite (exists), DO |

Notes:

- **Five of ten already exist** — this design finishes a drift that
  was already happening, which is evidence it is the right grain.
- `Mailbox`/`ThreadStore`/`Clock` are the SUBSTRATE plane (hosts
  provide them); `SamplingPolicy`/`Governor`/`Intrinsics` are the
  CONTROL plane (users provide them). The driver cannot tell the
  difference, which is the point.
- Compaction needs no new hook: the MECHANISM (apply a plan at the
  boundary) is driver; the POLICY is already userland
  (`Thread.compact` from charters; an auto-compaction layer is just a
  Governor that injects a plan).
- Prime Agent's whole Continual Harness maps to ZERO hooks: memory =
  `PersistentRef` + stance splices (lessons pattern), refine =
  an org agent opening PRs, skills = Skill layers. Their heartbeats =
  `Clock` + an intrinsic. Their agent messaging = the Actor verbs the
  driver already owns.
- pi's provider registry = `LanguageModel` (already a layer);
  per-tick model tiers ride `SamplingPolicy` + the §12 fragment
  annotations when those land.

## 5. What stays sacred (the driver's invariants)

The hooks deliberately CANNOT change these — they are the identity of
the system, and the reason two different users' kernels can still talk
to each other's agents:

1. Waiters ride inputs; quiescence resolves the round's waiters.
2. Steering joins at the sampling boundary; never aborts in-flight work.
3. The stance is re-rendered every tick; mention-is-presence compiles
   the toolkit (WireMode may change its PRESENTATION only).
4. Init runs once per run; the closure is the instance.
5. Settle cascades to session workers; crashes deliver typed errors to
   waiters and observers (the §11b error model).
6. Observations are seq'd per run; the seq is the consumer's cursor.

A user who needs to break one of these isn't assembling a kernel —
they are writing a different system, and `Kernel` (the interpret
service) remains the ultimate escape hatch for exactly that: the whole
driver is itself just the default implementation of one
Context.Service.

## 6. Migration plan (no big bang)

1. **Extract the control plane from KernelMemory** — `SamplingPolicy`
   and `Governor` as services with defaults equal to current behavior;
   KernelMemory consumes them. Pure refactor; tests green;
   KernelCloudflare untouched. *(DONE — `src/AI/SamplingPolicy.ts`,
   `src/AI/Governor.ts`, pinned by `test/AI/Hooks.test.ts`.)*
   `Intrinsics` is deliberately deferred to step 2: spawn/dispatch/
   skill are woven through run internals (supervision tree, delegation
   observations), so their host-capability surface should be designed
   against the substrate extraction, not guessed before it.
2. **Extract the substrate plane** — `Mailbox`, `ThreadStore`, `Clock`
   contracts (+ `Intrinsics` with its `IntrinsicHost` capability
   surface); KernelMemory becomes `Driver + LocalHost`. The driver
   module (`src/AI/Driver.ts`) is born here, ≤500 lines.
3. **Re-base KernelCloudflare on the driver** — DurableHost provides
   DO-backed Mailbox/ThreadStore/Clock; delete the duplicated
   algorithm (~1,200 lines die). This step VALIDATES the contracts: if
   the DO kernel needs a driver change, the seam was wrong.
4. **Move the org onto its own assembly** — `services/alchemy-org/src/
   kernel/` with org-authored policy layers (start as re-exports of
   the defaults; diverge by editing). The bootstrap loop
   (bootstrap.md) now covers kernel policy: the agent edits its own
   Governor and hot-reloads.
5. **The serverless/workflow host** when a real use arrives (the
   round-not-loop shape already guarantees it fits).

## 7. Open questions

- **Hook stability contract**: L2 contracts must be near-frozen or
  userland kernels break on upgrade. Proposal: hooks are `@experimental`
  until the DO re-base (step 3) proves them, then semver-frozen like L0.
- **ThreadStore vs RunJournal**: today the journal snapshots the whole
  thread at park; a first-class ThreadStore could make appends durable
  incrementally and subsume the journal. Decide at step 2 — bias
  toward keeping RunJournal as the snapshot/restore contract and
  letting ThreadStore be memory in LocalHost.
- **Intrinsic removal**: making spawn/dispatch removable interacts
  with supervision invariants (§5.5) — probably "removable but the
  cascade contract stays" (an agent with no spawn simply never has
  children).
- **How much of `KernelShared` is L0 vs L1**: the compile helpers
  (stance → toolkit) encode mention-is-presence and belong with the
  driver; `describeCrash`/provenance are L0 vocabulary.
