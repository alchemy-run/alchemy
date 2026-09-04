# Agentic Loops: A Synthesis

The design for how alchemy models agentic loops — bounded runs working toward
a goal, and perpetual processes with no exit condition — synthesized from ten
parallel research reports plus one authoring constraint:

| Report | File |
|---|---|
| Teleo-Reactive programs | [research/teleo-reactive.md](./research/teleo-reactive.md) |
| GOAP / STRIPS / HTN / Utility AI | [research/goap-htn-planning.md](./research/goap-htn-planning.md) |
| Elm / Redux / TCA / effects-as-data | [research/elm-redux.md](./research/elm-redux.md) |
| React / fiber / RSC / JSX-agents | [research/react.md](./research/react.md) |
| Statecharts / SCXML / XState | [research/statecharts-xstate.md](./research/statecharts-xstate.md) |
| BDI (PRS, AgentSpeak/Jason, GOAL) | [research/bdi.md](./research/bdi.md) |
| Behavior trees / subsumption | [research/behavior-trees.md](./research/behavior-trees.md) |
| Actors / OTP / Orleans / Temporal | [research/actors-otp-durable.md](./research/actors-otp-durable.md) |
| Control loops / MAPE-K / Kubernetes | [research/control-loops.md](./research/control-loops.md) |
| Shipped-harness survey (practice) | [research/harness-survey.md](./research/harness-survey.md) |
| Recursive Language Models | [research/rlm.md](./research/rlm.md) |
| Effect-native authoring constraint | [research/notes-effect-native.md](./research/notes-effect-native.md) |

## 1. Verdict

**The model is right. It is an unnamed member of a convergent family, and the
scaling risks are real but peripheral — they live in the kernel's physics and
the charter's authoring surface, not in the core bet.**

Every theoretical tradition, examined independently, found the same thing: the
charter/stance/kernel design is a rediscovery of its own central mechanism.

- The per-sampling turn re-evaluation is Nilsson's discrete-sampled continuous
  guard evaluation (T-R), a reactive behavior-tree tick (BT), SCXML's
  macrostep boundary (statecharts), a level-triggered re-orientation (K8s),
  and Boyd's Orient.
- A stance is a T-R durative action, a Moore output, an Elm view (`Html Msg`'s
  "a button not rendered cannot fire" *is* mention-is-presence), a setpoint
  plus control policy, and Halo 2's behavior masking.
- A run is a BDI intention (a keyed commitment whose transcript is its
  means-end elaboration), an Orleans grain, a `Reconcile(key)` instance.
- Park/wake/settle is T-R's homeostatic top rule — the theory explicitly
  blesses exit-condition-free perpetual processes: a *maintain* goal and an
  *achieve* goal are the same formalism differing only in whether the top
  condition is achieved or maintained.
- Steer-at-the-sampling-boundary was independently converged on by SCXML
  (run-to-completion), Orleans (grain turns), and Codex (`turn/steer`) — and
  the practice survey confirms nothing shipped does per-tick declarative
  stance re-derivation at all (Vercel's `prepareStep` is the nearest,
  imperative, approximation). That is the genuinely novel claim, and it held.

The scaling worries decompose cleanly (§8): charter complexity is an
*authoring-surface* problem (combinators, §4); concurrent runs, durability,
and cost are *kernel-physics* problems (supervision, passivation, budgets,
cache discipline, §5–6); drift is a *sensing* problem (observation, §4.1).
None require abandoning prose-first, model-as-deliberator, or the
world-outranks-beliefs doctrine — the reports repeatedly found those to be
the strongest parts of the design (GOAP: it's the winning Pengi/Suchman side
of the thirty-year planning argument; BT: world-owned `settle` fixes the
"leaves lie" failure the LLM-BT literature keeps patching; BDI: `settle` is
*stronger* than drop-on-believed-success).

## 2. Invariants — validated, do not touch

1. **Prose-first; the model is the deliberator.** Plan selection,
   context-condition evaluation, and means-end reasoning stay in the
   sampling. No symbolic planner, no plan-as-artifact DAG executor, no
   mechanical `S_O`. (GOAP, BDI, harness survey all *reject* transplanting
   their machinery here.)
2. **World-owned settlement.** Completion belongs to the world
   (`PullRequestMerged`), never to the model's self-report. Preserve through
   every change below.
3. **Steer at the sampling boundary.** Queue, promote at the boundary, never
   abort in-flight work. Triple-validated (SCXML, Orleans, Codex).
4. **Mention-is-presence** as the *authorization* semantics (the wire
   representation changes in §6.2 — the semantics do not).
5. **Per-run isolation, world-keyed identity.** Runs share facts (§7.3), never
   transcripts. BDI's goal-interference literature is a catalog of bugs this
   makes impossible; Cognition's single-writer rule agrees.
6. **Event-driven ticking.** No clock ticks; a parked run costs nothing. Time
   enters as a *wake source* (§5.3), not a tick frequency.
7. **Capability-by-omission through the R channel** — constitutional
   constraints as type-level facts. No tradition has an equivalent; several
   wish they did.
8. **Frozen-head cache discipline + superseding situations.** The hybrid
   (retained transcript, immediate stance, deltas as appends) is the right
   adaptation of React's model to a render target that has memory and a mind
   — with the corrections in §3 and §6.

## 3. Immediate fixes (bugs the research found)

Three live defects, each independently confirmed by multiple reports:

1. **The A→B→A restoration bug** (React, statecharts, BT, T-R). A stance that
   returns to the frozen head delivers nothing, so the last situation — which
   "supersedes instructions above" — is never revoked; the model believes B
   forever. Fix: diff against *last delivered* (initially empty), and deliver
   an explicit restoration when the delta returns to empty ("The prior
   situation no longer holds; the original instructions apply unchanged.").
   One-line semantics change in `actorTick`.
2. **The poisoned-key defect** (actors/OTP). `step` wraps `generateText` in
   `Effect.orDie` and crashed loops never restart: one transient 429 kills
   `owner/repo#7` permanently, and `admit` silently swallows all later input
   for it. Fix is §5.1 (supervision); the minimal immediate patch is:
   un-`orDie` the sampling step and retry with a capped exponential schedule.
3. **The restart-orphan bug** (control loops). After a restart, in-memory runs
   are gone but the Ledger persists; a re-polled `IssueOpened` gets
   `duplicate` → routed to `steer` → **silent no-op on a dead run**. The issue
   is orphaned forever. Root fix is durable runs + level-triggered observation
   (§3.1, §7.1) + the Ledger's three-valued `offer`; the interim mitigation is
   to treat `steer` against an unknown key as an admission (`send`) rather
   than a no-op.

And one prerequisite that four reports (Elm, React, statecharts, actors)
independently demanded:

4. **Named, schema-checked locals.** `AI.local`'s Symbol keys make run state
   unserializable *by construction* — no durable kernel, no replayable tests,
   no snapshot can exist over them. New signature:

```ts
const phase = yield* AI.local("phase", S.Literals(["triaging", "awaiting-author"]), "triaging");
// name: stable across isolates & deploys (the persistence key)
// schema: serialization + migration surface (optional for primitives, required for objects)
```

`Local` keeps (and converges on) the `Ref` API surface — `get`/`set`/
`update`/`modify` — but cannot *be* `Ref`: the `CurrentRun` requirement in its
R channel is precisely what "run-scoped" means at the type level, and
`FiberRef` fails both durability and outside-the-fiber access
([notes-effect-native.md](./research/notes-effect-native.md)). Writes become
*journaled* (each `set` is a recorded state event; the Map is a fold cache) —
the Elm discipline under the existing imperative surface, which is what makes
snapshots, replayable tests, and time-travel debugging of runs possible
without changing a single charter.

## 4. The kernel contract: one re-entrant function

*(Revised after review. An earlier draft presented `observe`, guarded stance
lists, and goals as first-class charter phases — primitive inflation. There
is exactly ONE charter-facing contract; everything else in this design is
either a userland library over ordinary Effect values or a kernel option
invisible to charters. This is the React property stated for our domain: a
single re-entrant function models state, observation, tools, prompt, and
exit — no DSL required to use it.)*

### 4.1 The contract

```ts
// INIT — once per interpretation. The closure is the component instance:
// allocate locals, define inline tools, resolve bindings.
type Charter = Effect<Turn | Fragment, EInit, RInit>;

// TURN — re-entrant: evaluated before every sampling and on every wake.
// Arbitrary Effect code. Returns what the run IS right now.
type Turn = Effect<Fragment | Outcome, E, R>;

// Outcome — the run concludes from inside. (The world can always settle
// first; it outranks.)  AI.done(value) | AI.refuse(reason)
```

Two widenings of today's `Turn = Effect<Fragment, never>` and nothing else:
the **return union** gains `Outcome`, and the **error channel opens** (`E`).
Everything the run needs is then expressible inside one function:

| need | expressed as | interpreted by |
|---|---|---|
| state | `AI.local` handles, closed over | kernel stores per run (journaled, §3) |
| observation | a fetch inside the turn — typed errors now legal | kernel retry/backoff per options; unchanged stance ⇒ re-park **without sampling** (the $0 no-op reconcile) |
| tools | mentions in the returned Fragment (incl. inline closures) | kernel compiles the toolkit |
| prompt | the returned Fragment | kernel: head freeze + situation diff |
| exit | `return AI.done(…)` / `AI.refuse(…)` | kernel settles from inside |
| branching | `Match`, ternaries, plain functions | nobody — it's just Effect |

The kernel's behaviors are *interpretations of the return value* — the
charter never names them: `Fragment` ⇒ diff, deliver situations, sample or
re-park; `Outcome` ⇒ settle; failure on `E` ⇒ supervision policy (§5.1).

The level-triggering correction (control loops: the AI layer is
edge-triggered today, violating alchemy's own reconciler doctrine) survives
as **doctrine, not structure**: events are wake-up hints; the turn renders
from what it *observes*, not from accumulated payloads; **turns fetch and
never sample** (T-R's guards-never-sample rule); judgment reaches guards only
via the judgment→tool→fact path. Observed state flows through the existing
situation machinery — no new model-facing protocol.

### 4.2 issues.ts under the contract

```ts
const charter = Effect.gen(function* () {
  // INIT — the component instance
  const phase = yield* AI.local("phase", S.Literals(["triaging", "awaiting-author"]), "triaging");
  const github = yield* GitHub.Issues(testAlchemy);
  const awaitAuthor = AI.Tool("await_author")`…`(() =>
    phase.set("awaiting-author").pipe(Effect.as("parked")));
  const resumeTriage = AI.Tool("resume_triage")`…`(() =>
    phase.set("triaging").pipe(Effect.as("resumed")));

  // TURN — observation, branching, prose, exit: all just Effect
  return Effect.gen(function* () {
    const issue = yield* github.get(yield* AI.runKey);     // observe (E = GitHubApiError)
    if (issue.state === "closed") return AI.done(issue);   // exit = a return value

    return yield* AI.prose`
This process manages GitHub issues for ${testAlchemy} from open to close.

${issueCard(issue)}

${(yield* phase.get) === "awaiting-author"
      ? AI.prose`This issue is parked on its author. Judge their latest
reply: when it closes the gaps, ${resumeTriage}; otherwise ask again
with ${Comment} — never re-ask an answered question.`
      : AI.prose`Check prior art with ${SearchIssues}. … Until ready,
${Comment} asks and ${awaitAuthor} parks the issue. A ready issue is
handed to ${Engineer}.`}`;
  });
});
```

No DSL. `Match`/ternaries are the branching mechanism; observation is a
fetch; exit is a return.

### 4.3 Everything else is userland

Each research recommendation that looked like a primitive is a plain function
over Effect values — importable, pipeable, ignorable:

```ts
// GOALS — ~6-line turn wrappers, not kernel vocabulary. `achieve` gives
// bounded runs observation-checked success (never the model's claim);
// Refused's evidence bar is the same predicate family, counted in a local.
export const achieve = <E2, R2>(until: Effect.Effect<boolean, E2, R2>) =>
  <E, R>(turn: Turn<E, R>): Turn<E | E2, R | R2> =>
    Effect.gen(function* () {
      if (yield* until) return AI.done();
      return yield* turn;
    });
// maintain = the wrapper that never returns done and renders its invariant's
// violation into the stance; condition-driven WAKING rides resync (§5.3).

// ORDERED GUARDED STANCES (T-R rule list ≡ BT Fallback, IROS 2016) —
// a ~15-line function: first true guard wins, last arg is the catch-all.
return AI.first(
  AI.when(ciRed, urgentCiStance),          // a layer added later never edits the ones below
  AI.when(phase.is("awaiting-author"), parked),
  triaging,
);

// ANNOTATIONS — pipeable Fragment → Fragment metadata the kernel MAY read
// and gracefully ignores otherwise (dwell/hysteresis, regression notes,
// consumption sets, decorators):
AI.prose`…`.pipe(
  AI.establishes("gaps closed → triaging"),
  AI.dwell("2 ticks"),
  AI.attempts(3, { onExhausted: escalate }),
  AI.deadline("3 days", { onExpired: nudgeAuthor }),  // registers a timer wake (§5.3)
);
```

The one legitimate reification survives from
[notes-effect-native.md](./research/notes-effect-native.md): closures cannot
be enumerated, so a charter that wants the structure-dependent kernel
features — whole-program head (§6.2), active-rule telemetry, livelock
detection, progression evals — must hand the kernel the alternation as data
(`AI.first`'s list). That is opt-in structure with graceful degradation, not
required vocabulary: a `Match` charter is fully valid and simply doesn't get
those features. Likewise `AI.machine` (statecharts report) remains the
userland escape hatch for charters that outgrow a list (~5+ phases with
declared transitions and entry/exit effects) — same journaled locals
underneath.

### 4.4 Kernel options, never charter vocabulary

Supervision, resync schedules, budgets, lanes/cooldowns, passivation,
reminders, union-toolkit masking (§5–§7) are options on `interpret` and
Layers. A charter cannot express them *because a charter shouldn't*: they are
the physics of the interpreter, and the same charter must run unchanged under
`KernelMemory` (which implements none of them) and `KernelDurable` (which
implements all of them).

## 5. Kernel physics

Everything in this section is kernel/Layer machinery — invisible to charters
except where noted. This is where "will it scale" actually lives.

### 5.1 Supervision (OTP)

```ts
interpret(term, charter, {
  supervision: {
    restart: "transient",                       // restart on defect; state survives
    backoff: Schedule.exponential("1 second").pipe(Schedule.upTo("5 minutes")),
    intensity: 3, period: "5 minutes",          // more → give up + escalate
    onGiveUp: (key, cause) => escalation.page({ term, key, cause }),
  },
})
```

Un-`orDie` the sampling step; provider errors are failures the supervisor
sees. Give-up **quarantines** (revivable by steer or human resume), never
tombstones. `dispatch` gets a timeout (`DispatchTimeout`, typed — OTP's 5s
`call` lesson, scaled). `BudgetExceeded` becomes a supervision event as well
as an error-channel value: budget exhaustion **parks with a situation** and
escalates — "a checkpoint, not a tombstone", now enforced. Intensity may be
denominated in dollars (open question, §9).

### 5.2 Admission, backpressure, damping (Kubernetes workqueue discipline)

Guards are physics, not prose:

- **Bounded mailboxes** with a typed `MailboxFull` — the event source decides
  (drop/retry/escalate). Our per-message cost is dollars, not bytes.
- **A global sampling token bucket** per interpretation (the model is the
  scarce resource) + **lanes** (React's scheduler transposed): `dispatch` =
  interactive, world events = default, resync = background, with expiration
  so background runs are never starved.
- **Per-(run, tool) cooldowns**, delivered as model-visible refusals ("you
  commented 90s ago; wait or park") — the model learns the damping.
- **Self-event filtering**: a process ignores wake-ups caused by its own
  actuations (match the org bot's author id in the Layer's routing). With
  cooldowns, this breaks the Issues↔PullRequests oscillation at both ends —
  two prose loops with cheap actuators and immediate sensors are an undamped
  positive-feedback pair otherwise.

### 5.3 Time as a wake source

`deadline`/`dwell` decorators, `maintain` invariant checks, resync schedules,
and stale-issue nudges all need timers that survive passivation: Orleans
reminders / DO alarms. The kernel exposes `remind(at, input)` on runs; a
reminder for a passivated run activates it. No clock ticks — time is just
another steer.

### 5.4 Postponement and wake predicates (gen_statem, Elm subscriptions)

A stance may declare what it consumes (`AI.consumes(GitHub.IssueCommented)` —
mention-is-presence extended from tools to events). Non-matching inputs are
postponed: **delivery is never gated, sampling is**. Postponed items re-offer
when the consumption set changes (OTP's retry-on-state-change). `dispatch`
always wakes; only steers are gated. A parked issue ignores drive-by comments
for the price of a predicate instead of a sampling.

## 6. Context economics

### 6.1 The three-channel doctrine

The control-loops report's spec/status split, applied to the window: the
**head** is spec (frozen constitution), **situations** are the level-triggered
process variable (superseding; old ones are provably dead weight), the
**transcript** is actuation history (what I did, what I promised —
conversational coherence). Three channels with different truth semantics and
different compaction rules, not one append-only fold.

### 6.2 Union toolkit + stance masking (the Manus correction)

Per-tick toolkit *rebuild* busts the KV cache at every phase flip (tools
serialize before the transcript; ~10× input-cost delta on invalidation).
Alchemy is uniquely positioned to fix this because the type system already
computes the **closed union of every tool any branch could mention**
(`CharterServices`): compile the union once per interpretation, send it
byte-stable every tick, and enforce the per-tick stance subset via provider
`tool_choice` constraints where supported plus a kernel handler gate returning
a model-visible refusal ("`await_author` is not available while triaging" —
the `skill` intrinsic already does exactly this). **Mention-is-presence stays
the semantics; the wire becomes mask-shaped.** Fall back to rebuild for
providers without constraints — one re-prefill per phase flip is defensible.

The same logic reopens the T-R report's head question: with `AI.first` the
whole rule list is data, so the head *could* render the entire program
(byte-stable, cache-perfect, rules as peers — the model sees the goal
gradient) with situations only naming the active rule. Whether
visible-but-inactive prose helps (anticipation) or hurts (role-playing
inactive rules) is empirical — benchmark before committing (§9).

### 6.3 Perpetuity: compaction at the park boundary

Every shipped long-horizon system is a relay of bounded episodes over durable
external state; alchemy's transcripts grow forever. The structural advantage:
**the stance re-derives from locals + world every tick, so alchemy's
transcript carries less irreplaceable state than any shipped harness** —
aggressive transcript management is *safer* here. The escalation ladder:

1. **Superseded-situation clearing** (dead by contract) and **tool-result
   clearing** (oldest, restorable results first) — mechanical, batched so the
   cache break amortizes (`clear_at_least` economics).
2. **Recitation within long phases**: re-inject the current situation every K
   assistant turns (kernel-driven; fights lost-in-the-middle).
3. **Park-boundary compaction/reset**: at quiescence past a token threshold,
   summarize (decisions, open threads, unresolved errors) and restart the
   prompt as head + summary-as-situation — a reset with handoff artifact, the
   strongest pattern per Anthropic's long-running-harness findings, and
   Temporal's continue-as-new in our vocabulary. Always a recorded event,
   never a silent mutation — and always *restorable*: evicted turns are
   archived to the run's `ContextStore` (§7.4) and the summary carries span
   references, so nothing is ever summarize-and-discarded.
4. **Reconsideration** (BDI's rational commitment): every run today is a
   *bold* agent — in-context inertia never re-deliberates, and Tileworld says
   that quietly degrades in fast-moving worlds. `AI.commitment({ reconsiderOn:
   [IssueEdited, …] })` names the cheap cues that force re-deliberation;
   mechanically, reconsideration *is* level 3 (fold to beliefs, drop the
   plan-so-far, re-render) seeded with the triggering input. Clean-slate
   alternative retry after approach failure (Jason's `-!g`) is the same
   mechanism seeded with a failure belief ("approach A failed because X — do
   not retry unchanged"), which also supplies `Refused`'s two-observation
   evidence bar.

## 7. Durability (KernelDurable)

### 7.1 Snapshot over replay — decided

Rejected: Temporal-style deterministic replay. The LLM is the decision-maker
and its output is already recorded on the transcript; a determinism contract
on turns is unenforceable and alien to the idiom; Cloudflare's own Workflows
made the same call. **Snapshot-based durability over the append-only
transcript**: persist `{ key, locals (named, schema'd), activeSkills, head,
lastSituation, transcript-or-summary, status: active|parked|quarantined|settled }`;
transcript appends as they happen (admission append and Ledger `offer` commit
in the same transaction); locals snapshot at every quiescence and after every
tool call.

- **Passivation is required, not optional** (Orleans): park → snapshot → drop
  the fiber and prompt from memory; wake on steer/settle/reminder → activate →
  load. Perpetual processes with thousands of parked runs are exactly the
  virtual-actor workload.
- **Rehydration re-derives, never replays**: on wake, re-run init (closures
  reconstruct deterministically — the RSC discipline: charter is code, run
  state is data), then observe → turn fresh. Recovery and charter upgrade are
  the same code path.
- **Charter edits are hot upgrades, free**: parked runs keep frozen heads (old
  prose pinned, cache-stable); the next wake renders under the new charter and
  changes arrive as situations — fleet-wide behavior upgrade at each run's
  next boundary, with no replay hazard *because* replay was rejected. The one
  obligation is locals migration (`AI.local(name, schema, initial,
  { migrate })`) plus a pre-deploy lint that re-renders the new charter
  against a corpus of persisted snapshots and reports situation-storm blast
  radius.
- **Tool idempotency keys**: `hash(runKey, transcript position)` on
  `CurrentRun`; the Ledger doubles as the dedupe journal for non-idempotent
  world effects. At-least-once is the honest contract everywhere else.

### 7.2 Testability (TCA's TestStore + T-R's verifier)

The journaled locals + scripted `LanguageModel` Layer give the exhaustive
harness:

```ts
const test = yield* AI.TestKernel(Issues, charter, { model: AI.scriptedModel([...]) });
yield* test.send(issueOpened, { key: "o/r#7" });
yield* test.expectTick({ toolCalled: "await_author", state: { phase: "awaiting-author" } });
yield* test.expectStance((s) => s.includes("parked on its author"));
yield* test.expectQuiescent();   // exhaustive: unasserted journal events fail the test
```

Plus **progression evals** on `AI.first` charters (seed rule *i*, drive,
assert rule *j < i* within N samplings — the regression property as an eval)
and rule-transition telemetry in production (livelock and dead-rule
detection).

### 7.3 Cross-run knowledge

Runs share nothing today; every run relearns the world (BDI: the missing
organ is shared *beliefs*, never shared transcripts). Adopt modestly:
`AI.shared("repo-facts", …)` — a term-scoped, curated, bounded belief base
rendered as a digest into every stance, written through inline tools with
provenance, superseded by key. Prefer the world/filesystem as the medium where
one exists (Devin/Manus/Anthropic practice). A settle hook ("write down what
the org should remember") extracts durable lessons from ended episodes. Lower
priority than everything above.

### 7.4 Transcript-as-environment (RLM)

The RLM report resolves the question §6.3 leaves open — what happens to
history the compaction ladder would destroy. An RLM (Zhang/Kraska/Khattab,
arXiv:2512.24601) never feeds the context to the transformer: the context is a
variable in an environment; the root model peeks/greps/slices it and spawns
sub-model calls over environment-selected slices that never transit the root's
window. In alchemy vocabulary the whole paradigm decomposes into existing
concepts — **an RLM is a charter + a `ContextStore` binding + budgets**; the
REPL is just a toolkit; `llm_query` is `spawn` with a context grant. No new
kernel concept is required, which is the strongest sign the paradigm fits.

What we adopt:

- **`ContextStore`** — a run-scoped, append-only span store as an Effect
  service (array-backed in `KernelMemory`, storage-backed on the DO kernel),
  with history access exposed as a **Skill** (`grep_history`/`read_span`/
  `list_spans` — dormant until history matters, which is exactly what skills
  are for; possibly kernel-gated on store size, since base-LM beats RLM below
  the crossover point).
- **Restorable eviction amends §6.3's ladder**: the kernel never
  summarizes-and-discards — evicted turns move to the store and are replaced
  by one restorable marker ("turns 12–87 archived as span `s3`"). Summaries
  become *pointers* to spans, not replacements for them. Eviction happens in
  large batches at quiescence (one cache break, amortized). The RLM paper's
  summary-agent baseline losing on every dense task is the empirical warning
  against pure compaction.
- **`spawn` grows a `context:` grant** — pass-by-reference span references
  alongside the written brief, resolved by the kernel into the *worker's*
  window (never transiting the spawner's), plus a `model: "fast" | "default"`
  tier so map-over-history work runs cheap. The isolation doctrine
  generalizes, it doesn't break: "the worker sees only what you write plus
  what you explicitly hand it by reference" — grants are explicit, enumerable,
  auditable, and only over stores the spawner's tick granted. No
  `context: "*"`, ever.
- **Budgets stay kernel physics** (§5.1–5.2 already say this; the RLM
  trajectories — thousands of redundant sub-calls — prove soft discipline
  fails): breach triggers a model-visible salvage path, never a crash.

Rejected for now: an in-charter REPL/`eval` (discrete store tools cover the
observed access patterns; revisit as a V8-isolate capability on the DO kernel
if an OOLONG-shaped charter ever appears), depth>1 recursion (workers stay
leaves; hierarchy goes through named `dispatch`), and RLM as the *run* model
(it's a query-time strategy; our runs are perpetual and world-settled — RLM
techniques slot inside runs, not around them).

Note: the "RLM engine for agents in Effect" claim resolved to
`mepuka/recursive-llm` — real and idiomatically sound (Scheduler loop,
budget-salvage, sandbox IPC), but a two-star single-author *completion engine*
with no durability, not an agent kernel. A design reference, not a dependency.

## 8. The scaling worries, answered

| Worry | Answer | Section |
|---|---|---|
| State machines smuggled into prose ternaries | `AI.first` guarded stances (userland, ordered, complete-by-construction); `AI.machine` at ~5+ phases; decorators replace prose wishes | §4.3 |
| Hierarchical goal decomposition | Keep model-as-chooser (`spawn`/`dispatch` *is* HTN with prose methods); Skills get method heads (`task:`) and may carry their own init/turn (subtrees); dispatch becomes revocable (scoped to the parent run, checked at child sampling boundaries) | §4.3, reports |
| Many concurrent runs | Passivation + reminders (virtual actors); lanes + token bucket; utility-scored scheduling when contention is real | §5.2, §7.1 |
| Durability | Named journaled locals; snapshot-at-park; rehydrate-by-re-derivation; hot charter upgrade | §3, §7.1 |
| Cost | Budgets that park (not crash); union-toolkit cache stability; wake predicates; $0 no-op resyncs; cooldowns | §5, §6 |
| Drift / missed events | Level-triggered observation in the turn + jittered resync; events demoted to hints | §4.1, §5.3 |
| Coupled-loop oscillation | Self-event filtering + cooldowns + dwell/hysteresis; oscillation telemetry | §5.2 |
| Unbounded transcripts | Three-channel doctrine + park-boundary compaction ladder + reconsideration | §6 |
| Testability | TestKernel exhaustive harness + progression evals + deterministic guards/goals | §7.2 |

## 9. Adoption order

1. **Now (fixes)**: restoration announcement; un-`orDie` + retry on sampling;
   steer-on-unknown-key admits; named/schema'd locals (journaled).
2. **Kernel contract**: widen `Turn` to `Effect<Fragment | Outcome, E>`
   (exit-from-inside + typed observation errors); kernel handles Outcome ⇒
   settle, error ⇒ supervision, unchanged-stance ⇒ re-park without sampling.
3. **Userland library** (no kernel changes): `achieve`/`maintain` turn
   wrappers; `AI.first`/`AI.when`; annotation combinators (`establishes`,
   `dwell`, `attempts`, `deadline`, `consumes`); `Refused` ratification;
   budgets park-and-escalate (kernel option).
4. **Kernel physics**: supervision options; lanes + token bucket + cooldowns +
   self-event filtering; resync schedules; union toolkit + masking.
5. **KernelDurable**: snapshot-at-park, passivation, reminders, migration
   lint; TestKernel.
6. **Exploratory**: whole-program head (benchmark vs frozen-first-branch);
   `AI.shared`; reconsideration policy tuning; `AI.machine`; `ContextStore` +
   history skill + spawn context grants (§7.4); settle-time memory
   extraction.

## 10. Open questions (the empirical agenda)

1. **Whole-program head vs frozen-first-branch** — does visible-but-inactive
   rule prose help or hurt? (T-R §6.1, React §6.5.)
2. **Situation fatigue** — after 50 situations, does instruction-following
   degrade enough to force re-heading? (React §6.5, harness §6.2.)
3. **Reset vs in-context correction** — does clean-slate retry actually beat
   steered correction at current model quality? (BDI §6.2, harness §6.3.)
4. **Material-change detection** for observed snapshots (canonicalize volatile
   fields; when is a change worth a sampling?). (Control loops §6.1/§6.4.)
5. **Budget/intensity denomination** — dollars vs counts; cost attribution
   across spawn/dispatch trees. (Actors §6.6, GOAP §6.3.)
6. **Who ratifies judgment-shaped satisfaction** — two-tier `satisfied` +
   model-as-judge `assess` with the tier recorded in the type? (GOAP §6.1.)
7. **Where the Escalations supervisor lives** — a Process whose charter
   triages `onGiveUp` events, without being able to crash into itself.
   (Actors §6.1.)
