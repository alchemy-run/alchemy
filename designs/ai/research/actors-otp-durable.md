# The Actor Model, Erlang/OTP, and Durable Execution

Research memo for the Alchemy AI kernel design: does fifty years of engineering tradition around perpetual, supervised, message-driven processes validate the charter/stance/Actor model — and what does it say we are missing?

Grounding: `packages/alchemy/src/AI/{Kernel,KernelMemory,Actor,Run,Agent,Process,Prose,Errors}.ts` and `services/alchemy-org/src/{issues,pull-requests,ledger}.ts`, read in full against the primary sources below.

---

## 1. The paradigms, precisely

### 1.1 Actors (Hewitt 1973 / 2010)

An actor is the universal primitive of concurrent computation: on receipt of one message it may (a) send finitely many messages to actors whose addresses it knows, (b) create finitely many new actors, (c) designate the behavior for its next message. Everything is message passing; there is no shared state, no global clock, and — Hewitt's 2010 emphasis — **unbounded nondeterminism**: delivery is guaranteed but delay is unbounded (the arbiter argument), so a system's semantics must be closed under arbitrarily long waits. Two properties matter for us: **serial processing per actor** (one message at a time; the mailbox is the only synchronization primitive) and **address-based identity** (you interact with a name, never a memory location). The 1973 paper is a formalism, not a runtime — it deliberately says nothing about failure, persistence, or overload. Everything below is engineering added on top.

### 1.2 Erlang/OTP: the failure discipline

Armstrong's thesis reframes the actor model as a **fault-tolerance architecture**. Its six requirements (concurrency, error encapsulation, fault detection, fault identification, code upgrade, stable storage) are exactly the checklist our kernel will be graded against. The core doctrine:

- **Let it crash / "let some other process fix the error."** A process that cannot do what it was asked must crash immediately — not handle the error locally — because the only recovery that works across machine failure is *remote* recovery. Corollary: the recovery code lives in a *different* process (the supervisor), cleanly separated from happy-path code.
- **Supervision trees.** A supervisor starts, monitors, and restarts children under a declared strategy: `one_for_one` (restart only the failed child), `rest_for_one` (restart it and everything started after it), `one_for_all`. Restart types per child: `permanent` (always restart), `transient` (restart only on abnormal exit), `temporary` (never). Crucially, **restart intensity**: if more than `intensity` restarts occur within `period` seconds, the supervisor kills all children and terminates *itself* — escalating the failure to *its* supervisor. Failure handling is a policy ladder, and the top of the ladder is a human.
- **gen_server** standardizes the request/reply actor: `call` (synchronous, **with a default 5-second timeout** — every synchronous wait in OTP is bounded), `cast` (async), and mailbox overload as the canonical failure mode of unbounded inboxes.
- **gen_statem** is the state-machine behavior: state × event → transition, with three features directly relevant to charter phases: (1) **event postponement** — a state that can't handle an event returns `{postpone, true}`; the engine keeps a queue of postponed events and **retries them all after a state change** (`NextState =/= State`), the principled substitute for selective receive; (2) **state-enter calls** — a callback fired automatically on every state change, so entry logic is co-located with the state rather than remembered at every transition site; (3) **state time-outs** — auto-cancelled on state change.
- **Hot code upgrade** (`code_change`): a running process migrates its state term when its module is upgraded — code upgrade is a *first-class state migration*, not a redeploy.

### 1.3 Akka: persistence and sharding

Akka contributes two industrializations. **Akka Persistence** is event sourcing for actors: an entity persists *events* (not state); recovery replays events over the behavior to rebuild state; **snapshots** bound replay cost. Single-writer principle: exactly one active persistent actor per `PersistenceId`. **Cluster Sharding** is keyed-entity management: messages addressed by entity ID are routed to the one live instance; **passivation** stops idle entities to reclaim memory (the entity sends `Passivate` to its shard; the shard *buffers* incoming messages between passivation and termination, then delivers them to the fresh incarnation — no message loss); `remember-entities` optionally restarts entities proactively after rebalance/crash instead of on next message. Default mailboxes are unbounded, and Akka's documentation is blunt that overload must be handled at the application level.

### 1.4 Orleans: virtual actors

Orleans (Bykov et al., MSR-TR-2014-41) makes the decisive move for our design: a **grain always exists, logically**. There is no create/destroy in application code — you `GetGrain(key)` and call it; the runtime **activates** an in-memory instance on first message, loads its declared persistent state *before* activation (`SetupState` stage), **deactivates** it after idle time, and re-activates it (possibly on another silo) on the next message. Failure recovery is mostly transparent: a grain on a crashed silo is simply re-activated elsewhere on next contact. **Reminders** complete the model: persistent timers that fire *whether or not the grain is active* — a reminder for a deactivated grain triggers a fresh activation. This is precisely the "perpetual process without a perpetual process" trick: perpetual *addressability* with lazily materialized *execution*. Orleans deliberately trades Erlang's supervision expressiveness for lifecycle automation.

### 1.5 Durable execution: Temporal/Cadence, Restate, Cloudflare Workflows

Temporal's contract: **workflow code must be deterministic**; every side effect goes through the SDK, which records an event in an append-only **Event History**. On crash, the workflow function re-executes *from the top* on any worker; recorded events answer the historical calls (activities are not re-run — their recorded results are returned), until execution catches up and resumes live. Consequences, all load-bearing:

- **Activities are at-least-once.** A worker can die after the side effect but before recording it. No engine can close that window; hence Temporal's insistence on **idempotent activities** (idempotency keys derived from workflow ID + step position).
- **Non-determinism is a typed error**: on replay, emitted commands are matched against history; a mismatch fails the workflow task. Changing workflow code under in-flight executions therefore requires **versioning** — `patched()`/`GetVersion` branches recorded in history, or worker-versioning that pins old executions to old workers, plus replay testing.
- **History has limits** (50k events / 50 MB) — `continue-as-new` rolls a long-lived workflow into a fresh execution carrying state forward. Perpetual processes in Temporal are *chains* of bounded histories.

Restate keeps journaled replay but makes handlers suspendable (serverless-friendly) and adds **virtual objects**: keyed handlers with K/V state and single-writer semantics — Orleans grains with a journal. **Cloudflare Workflows** takes the *checkpoint* variant instead of full replay: only code inside `step.do()` is recorded and skipped on recovery; code *between* steps re-runs. Each instance is backed by a Durable Object (single-writer, strongly consistent storage, alarms = Orleans reminders, hibernation = passivation). The DO platform is the natural substrate for our durable kernel, and notably it is *snapshot-shaped*, not replay-shaped.

### 1.6 Event sourcing invariants

State = fold of an append-only event log; events are immutable facts, recorded *after* validation but *before* acknowledgment; snapshots are a pure optimization (state must be re-derivable from events alone); reading a projection never mutates the log. The one invariant that bites designs later: **anything not derivable from the log is not recoverable** — hidden mutable state alongside an event log is the classic corruption.

## 2. Primary sources

What I actually read (fetched in full or in substantial excerpt during this research):

- Hewitt, Bishop, Steiger, *A Universal Modular ACTOR Formalism for AI*, IJCAI 1973 — https://www.ijcai.org/Proceedings/73/Papers/027B.pdf (full PDF text)
- Hewitt, *Actor Model of Computation: Scalable Robust Information Systems*, 2010 — https://arxiv.org/abs/1008.1459 (full PDF text; unbounded nondeterminism, arbiter argument, Computational Representation Theorem)
- Armstrong, *Making reliable distributed systems in the presence of software errors*, PhD thesis 2003 — http://erlang.org/download/armstrong_thesis_2003.pdf (chapters 2, 4.4, 5); plus his erlang-questions post "Let some other process fix the error" (2003) — https://erlang.org/pipermail/erlang-questions/2003-April/008648.html
- OTP design principles: gen_statem behavior — https://www.erlang.org/doc/apps/stdlib/gen_statem.html and https://www.erlang.org/docs/29/system/statem.html (postpone semantics, state-enter, complex state); Supervisor behavior — https://erlang.org/documentation/doc-15.0-rc1/doc/system/sup_princ.html (strategies, intensity/period, restart types)
- Bertram et al. (Bykov), *Orleans: Distributed Virtual Actors for Programmability and Scalability*, MSR-TR-2014-41 — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Orleans-MSR-TR-2014-41.pdf (activation/deactivation, persistence facility, timers vs reminders)
- Akka Cluster Sharding docs — https://doc.akka.io/libraries/akka-core/current/typed/cluster-sharding.html (passivation with shard-side buffering, remember-entities, single-writer)
- Temporal docs: Workflow Definition (determinism, patching) — https://docs.temporal.io/workflow-definition; Event History — https://docs.temporal.io/workflow-execution/event; idempotency blog — https://temporal.io/blog/idempotency-and-durable-execution
- Restate, *What is Durable Execution?* — https://www.restate.dev/what-is-durable-execution and https://www.restate.dev/vs/temporal
- Cloudflare Workflows semantics (step.do checkpointing, DO backing) — vendor docs plus https://know.2nth.ai/explainers/tech/cloudflare/workflows

## 3. Mapping to LLM agentic loops

The mapping is unusually clean because an agentic loop already *is* an actor with an event-sourced core:

| Alchemy | Actor tradition |
|---|---|
| Run keyed `owner/repo#7` | Orleans grain / Akka sharded entity / Restate virtual object / Temporal workflow ID |
| Mailbox + serial loop per run | Actor mailbox, single-threaded grain turn |
| `dispatch` (admit + await quiescence) | `gen_server:call` — **but ours has no timeout** |
| `send` | `cast` |
| `steer` promoted at sampling boundary | Message delivery at turn boundary; the pi/codex discipline is exactly grain turn-based concurrency |
| `settle` (idempotent, world-owned) | External completion signal; Temporal signal-with-completion |
| Transcript (append-only prompt) | Event history / persistence journal |
| Charter turn (re-evaluated every tick) | Workflow code / gen_statem state callback |
| `AI.local` phase cells | gen_statem `State`+`Data` |
| Tool executions | Activities — at-least-once, must be idempotent |
| LLM sampling | A nondeterministic activity whose *result is recorded* — never replayed, always read back |
| Ledger `offer` | Admission dedupe — at-most-once *admission*, nothing more |
| Charter edit over parked runs | Hot code upgrade / workflow versioning |
| Budget ceilings | Supervision policy (restart intensity analog) |

The load-bearing questions:

**Is a charter turn "workflow code" that must be deterministic?** Only if we choose replay-based durability — and we should not (see §5.2). The decisive observation: in Temporal, replay re-executes the *decision code* and reads back recorded *activity results*. In an agentic loop, the decision-maker is the **LLM itself**, and its output is already recorded on the transcript. The turn effect does not make decisions; it *frames* them (renders the stance), and the stance diff is *also* recorded on the transcript as `<situation>` messages. So the transcript already captures everything replay would need to reconstruct the *conversation* — what it cannot reconstruct is `AI.local`, because locals are mutated inside tool handlers (recorded only as opaque tool results) and, more dangerously, can be mutated by turn effects themselves, which nothing records.

**Are runs virtual actors?** They must become so. A perpetual process with no exit condition means every issue ever opened has a run parked forever. Orleans' answer is the only one that scales: the run's *identity* is perpetual; its *activation* is not. Park → persist → deactivate; wake on steer/settle/reminder → activate → load state. Without this, "thousands of concurrent runs" means thousands of live fibers each holding a full transcript in a loop-local variable — which is the current implementation.

**What is exactly-once here?** Nothing, and pretending otherwise is the classic error. The composable guarantees on offer: at-most-once admission (Ledger), at-least-once tool effects (retry), exactly-once *recording* (transcript append under single-writer). Temporal's discipline — derive an idempotency key from (workflow ID, step position), pass it to every activity, make the receiver dedupe — is directly adoptable: (runKey, transcript position) is our (workflow ID, event ID).

## 4. Comparison with alchemy's model — what breaks, what's right

### 4.1 What the tradition predicts breaks (with code receipts)

**No supervision — and a poisoned-key failure mode.** `KernelMemory.step` wraps `model.generateText` in `Effect.orDie` (`KernelMemory.ts:541`): every transient provider failure (429, 500, timeout) is a *defect* that kills the run's loop permanently. The `onExit` handler correctly propagates the failure to waiters and completes `settled` — but the dead run stays in the `runs` map, and `admit` silently drops input for settled runs. Net effect: **one rate-limit blip permanently poisons `owner/repo#7`**; every later webhook for that issue is swallowed until the isolate restarts. OTP calls this a `temporary` child with no supervisor — the configuration you never ship. Armstrong's whole thesis is that the crash is fine; the *absence of anyone responsible for the crash* is the bug.

**Unbounded everything.** Inboxes are `Queue.unbounded` (`KernelMemory.ts:550`); `dispatch` awaits a `Deferred` with no timeout (OTP defaults `call` to 5s for a reason — a hung delegate hangs its host forever, transitively); nothing bounds run count or admission rate. Erlang's most famous production failure mode is the unbounded mailbox of a slow consumer; ours is worse because each queued item eventually costs *model tokens*, not just memory. Backpressure must exist at admission (the Ledger seam is well-placed for it) and at the mailbox.

**No passivation.** A parked run is a live fiber blocked on `Queue.take`, holding the entire transcript in the `loop` function's local `prompt` variable. Memory grows monotonically with issues-ever-opened. Orleans passivation is not an optimization here; it is the difference between the model working and not working at the stated scale.

**No poison-message handling.** A steer whose content reliably crashes the loop (or drives the model into a token-burning stall) is redelivered nowhere, quarantined never. OTP restart intensity (N crashes in M seconds → escalate) and the DLQ tradition both answer this; we have neither.

**Locals are not durable-ready.** `AI.local` keys cells by `Symbol("alchemy/AI/Local")` — construction-site identity with no stable name (`Run.ts:70`). No serializer can round-trip that map. Durability requires *named* locals (the name is the schema), and the event-sourcing invariant warns us: locals mutated by turn effects are hidden state alongside a log — the classic corruption. Snapshotting saves us only if every local is nameable and serializable.

**dispatch waiters are lost on crash-restart.** Once we add restart, the `waiters: Array<Deferred>` (in-memory) must either be rebuilt or the contract weakened; Temporal's answer is that *callers* poll/await durable results by ID, not by held promise.

### 4.2 What alchemy already gets right

- **The steer-at-sampling-boundary discipline is grain-turn concurrency**, independently rediscovered. Orleans and gen_statem both agree: interleave at message/turn boundaries, never mid-computation.
- **`settle` as world-owned, idempotent ending** matches the tradition's best practice (external completion; "the world outranks the org's beliefs") and is cleaner than Temporal's cancellation zoo.
- **The transcript is already an event history**: append-only, records inputs, model outputs, tool calls/results, and stance diffs. We are one seam away from event-sourced durability without any redesign of the loop.
- **Typed errors + Layers + Scope** are genuinely ahead of OTP: `BudgetExceeded` in the error channel is a *typed* escalation signal (Erlang crashes carry untyped reasons); `interpret` being scoped means actor lifetime is structurally tied to its Layer — Erlang links, re-derived in the type system. Capability-by-omission (a charter that never mentions `${MergePullRequest}` cannot merge) has no OTP analog at all.
- **The charter turn re-evaluated every tick is gen_statem's state callback + state-enter call in one**: the stance diff *is* an automatic state-enter action, delivered as a `<situation>` message. The phase-local pattern in `issues.ts` (triaging ↔ awaiting-author) is a hand-rolled two-state gen_statem, and it is the right shape.
- **The Ledger honestly claims only admission dedupe** — no exactly-once mythology in the design docs. Correct starting point.

## 5. Steal / adapt / reject

### 5.1 STEAL: supervision on `interpret` (OTP)

Restart policy, intensity, and escalation as options — per-term, since a Process's implementation Layer is exactly the "supervisor" seam:

```ts
export interface SupervisionOptions {
  /** transient: restart on defect; the run's state survives (§5.2). */
  readonly restart?: "transient" | "temporary";
  readonly backoff?: Schedule.Schedule<unknown, unknown>;      // default: exponential, capped
  /** intensity/period: more than `intensity` crashes within `period` → give up + escalate. */
  readonly intensity?: number;                                  // default 3
  readonly period?: Duration.DurationInput;                     // default "5 minutes"
  /** The escalation seam — OTP's "supervisor of the supervisor". */
  readonly onGiveUp?: (runKey: string, cause: Cause.Cause<unknown>)
    => Effect.Effect<void, never, RuntimeContext>;
}

interpret(term, charter, { supervision: {
  restart: "transient",
  onGiveUp: (key, cause) => escalation.page({ term: "Issues", key, cause }),
}})
```

Mechanically: un-`orDie` the sampling step so provider errors are *failures* the loop's supervisor sees; on failure, if intensity allows, re-enter the loop from persisted state (the transcript survives; in-memory it's the loop-local prompt, so restart re-parks with what it has); on give-up, mark the run `quarantined` — **not settled** — so a later steer or a human `resume` can revive it. This one change deletes the poisoned-key failure mode. Also steal the **`call` timeout**: `dispatch(item, { timeout: "10 minutes" })`, failing the *waiter* (typed `DispatchTimeout`), never killing the run.

Treat `BudgetExceeded` as a supervision event, not only an error: today it rides the error channel to whichever parent happens to await; under supervision it *also* flows to `onGiveUp`-style policy (`onBudget?`) so escalation happens even for `send`-originated runs that nobody is awaiting. The Errors.ts doctrine ("a checkpoint, not a tombstone") is already supervision language — make the kernel enforce it: budget exhaustion parks + escalates, never kills.

### 5.2 STEAL: virtual-actor passivation (Orleans) with snapshot + append-only-transcript durability — and REJECT full Temporal replay

The durable kernel should be **snapshot-based over an append-only transcript log**, not deterministic-replay-based:

- The transcript is already the event history, and the expensive nondeterminism (LLM sampling) is already recorded in it. Replay would buy us the ability to *re-derive* locals from history — at the price of a determinism contract on turn effects (no clock, no fetch, no `AI.local` writes outside recorded positions) that is unenforceable in "turns can run arbitrary Effects" and alien to the charter idiom. Cloudflare's own Workflows product made the same call: checkpoint, don't replay.
- Instead, adopt the **reconciler doctrine alchemy already lives by**: on wake, *re-evaluate the turn fresh against restored state* (observation over assumption). Old stances are never re-rendered; the recovered run's next tick renders whatever the charter says *now*. This makes recovery and charter upgrade the same code path (§5.4).
- Per-run durable record: `{ key, transcript (append-only), locals (named snapshot), head, lastSituation, activeSkills, status: active|parked|quarantined|settled, settledOutcome? }`. Persist transcript appends as they happen (record-before-ack for admissions: Ledger `offer` and transcript admission append should commit together — same D1/DO transaction); snapshot locals at every quiescence boundary and after every tool call.

Passivation hooks, DO-shaped:

```ts
interface DurableRun {
  /** Park reached quiescence → persist snapshot → drop fiber + prompt from memory. */
  readonly passivate: Effect.Effect<void>;
  /** steer/settle/reminder for a passivated key → load snapshot → re-enter loop. */
  readonly activate: Effect.Effect<void>;
  /** Orleans reminder / DO alarm: wake a parked run at a time — "nudge author in 7 days". */
  readonly remind: (at: DateTime.Utc, input: unknown) => Effect.Effect<void>;
}
```

`remind` is the sleeper hit: perpetual processes need *time* as a wake source (stale-issue nudges, SLA escalation), and Orleans reminders/DO alarms are the only way to get it without pinned fibers.

Prerequisite (small, do it now): **named locals**. `AI.local("phase", "triaging")` — the string key replaces the Symbol, making the locals map serializable and diffable. Add a lint that flags `AI.local` without a name once the durable kernel lands. Consider requiring a Schema for non-primitive locals.

### 5.3 ADAPT: gen_statem postponement for steers

Today `loop` drains the whole inbox into user messages every tick regardless of phase. An `awaiting-author` run receiving a CI-failure event either confuses the stance or gets prematurely woken. gen_statem's answer: postpone; retry all postponed events after a *state change*. Our state is the phase local, so:

```ts
// In the charter's turn: declare what this phase consumes. Everything else
// is postponed — held by the kernel, re-offered when the rendered stance's
// consumption set changes (our NextState =/= State).
return yield* AI.prose`
This issue is parked on its author.
${AI.consumes(GitHub.IssueCommented)}   // only author replies wake this phase
…`;
```

Kernel semantics: at each park, inputs not matched by the current stance's consumption set go to a per-run `postponed` list; when a tick's rendered consumption set differs from the previous tick's, postponed items are re-offered *ahead of* new arrivals (OTP's queue-restart order). This is deliberately declared in prose — mention-is-presence extended from tools to events, which the `In` type of `Actor` already gestures at. Also adopt gen_statem's **state time-out**: `AI.consumes(..., { timeout: "7 days", onTimeout: nudge })` — cancelled automatically on phase change, exactly OTP's semantics, and it composes with `remind`.

### 5.4 ADAPT: charter versioning = hot code upgrade, and it mostly falls out

The head-frozen system prompt + stance-diff design is accidentally an excellent `code_change` story, *if* durability is snapshot-based: a charter edit deploys; parked runs keep their frozen heads (old prose pinned — prompt-cache-stable, no history rewrite); on next wake the turn re-evaluates under the *new* charter, and every changed block arrives as a `<situation>` message ("latest supersedes"). That is a **fleet-wide behavior upgrade at the next sampling boundary of each run** — Erlang's hot upgrade with the migration message auto-generated. It is a feature, not a hazard, precisely *because* we rejected replay: nothing ever re-renders an old tick under new code, so Temporal's non-determinism error cannot exist here. Two disciplines to make it safe:

- **Locals migration** is the one genuine `code_change` obligation: a new charter reading `AI.local("phase")` whose value domain changed needs a migration hook — `AI.local("phase", initial, { migrate: (old) => ... })` — run on first activation under the new charter version (stamp a charter hash into the run record).
- **Replay testing's analog**: a `AI.lint`-style check that re-renders the new charter's turn against a corpus of persisted run snapshots and reports which parked runs would receive situation storms (mass block changes), so an operator sees the blast radius before deploy.

### 5.5 STEAL: idempotency-key convention for tools (Temporal)

Tool executions are at-least-once the moment supervision retries exist (a crash after the tool's effect but before the transcript append re-runs the sampling, and the model may re-call the tool). The Temporal discipline, in alchemy idiom — the kernel already provides `CurrentRun`; extend it:

```ts
export interface CurrentRunService {
  readonly key: string;
  readonly locals: Map<string, unknown>;
  /** Deterministic per-tool-call token: hash(runKey, transcript position, toolName). */
  readonly idempotencyKey: string;
}

// A tool handler for a non-idempotent world effect:
const merge = AI.Tool("merge_pull_request")`…`((params) =>
  Effect.gen(function* () {
    const { idempotencyKey } = yield* CurrentRun;
    return yield* github.merge({ ...params, idempotencyKey }); // receiver dedupes
  }));
```

For receivers without native idempotency support, the Ledger is the dedupe: `ledger.offer(`tool:${toolName}`, idempotencyKey, params)` before executing, recording the result on the same row — turning the Ledger into a lightweight effect journal for exactly the tools that need it. Document loudly that everything else stays at-least-once.

### 5.6 STEAL: bounded admission and mailboxes

`Queue.bounded` per run (small — a run that is 100 messages behind is a bug, not a backlog) with a typed `MailboxFull` returned from `send`/`steer` so the *event source* decides (drop, retry with backoff, or escalate); an admission-rate ceiling at the Ledger seam (token bucket per queue) because each admitted item costs dollars, not bytes. Reject Erlang's default of unbounded-and-pray; our per-message cost is six orders of magnitude higher.

### 5.7 ADAPT: continue-as-new = transcript compaction

Temporal's history limits force `continue-as-new`; our analog is context-window pressure. Steal the *shape*: at a quiescence boundary, the kernel rolls the run — summarize transcript → fresh transcript seeded with (frozen head, summary-as-situation, locals carried verbatim) — as an explicit kernel operation with a recorded `compacted` event in the log, never a silent mutation. The append-only invariant survives (old segments archived, not rewritten).

### 5.8 REJECT

- **Full deterministic replay of turns** (§5.2) — wrong cost/benefit for LLM loops; the transcript already records the nondeterminism that matters.
- **Erlang-style untyped exit reasons / dynamic supervision trees as the *user* API** — Effect's typed errors and Layer scoping are strictly better; supervision should be *options on interpret*, not a tree the user assembles.
- **`rest_for_one`/`one_for_all` across runs** — runs keyed by world identity are independent by construction; sibling-restart strategies answer dependency ordering we don't have *between runs*. (Between *Layers* — kernel dies → all actors die — Effect Scope already implements one_for_all.)
- **Akka remember-entities eager reactivation** as default — waking thousands of parked runs on deploy is a token bill, not resilience. Wake on message/reminder only; offer eager wake as an opt-in migration tool.
- **Exactly-once as a product claim** — keep the Ledger's honest at-most-once-admission + idempotency-key discipline.

## 6. Open questions

1. **Where does the supervisor live for a *Process*?** The implementation Layer owns the Actor — should `onGiveUp` escalation route to a human seam (Discord), to a parent Process's run, or to a dedicated Escalations process? OTP says supervisors are processes too; an `Escalations` Process whose charter triages `onGiveUp` events is the self-similar answer, but it must not be able to crash into itself.
2. **Turn-effect purity**: do we *forbid* `AI.local` writes and world I/O in turn effects (lint), or merely document that they are re-executed on every tick and after every recovery? Snapshot durability tolerates impurity; situation-diff stability does not (a turn reading a volatile clock renders a new situation every tick).
3. **Waiter durability**: after passivation-and-recovery, `dispatch` waiters are gone. Does `dispatch` become "admit + durable await by (runKey, admission id)" — Temporal-style — or do we accept that dispatch is an in-memory convenience and cross-process callers must poll the run record?
4. **Postponement vs. the model's judgment**: gen_statem postponement is mechanical; but sometimes the *model* should see the out-of-phase event and decide (the `awaiting-author` charter already judges replies). Where is the line between kernel-postponed and prose-adjudicated events? Likely: postpone by declared consumption set, but always deliver `settle`-adjacent and safety events.
5. **Ledger three-valued answer** (`accepted | duplicate | settled`, flagged open in `ledger.ts`): re-admission after settle is the virtual-actor "grain never dies" question in disguise — does a reopened issue get a fresh run seeded from the old run's summary (continue-as-new across settlement) or a resumed transcript?
6. **Cost-aware supervision**: OTP intensity counts crashes; our restarts re-buy model tokens. Should intensity be denominated in dollars (integrate with `AI.budget`) rather than counts?
