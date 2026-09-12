# Teleo-Reactive Programs and the Alchemy Charter Model

Research memo: Nilsson's Teleo-Reactive (T-R) programs as a lens on Alchemy AI's
charter/stance/kernel design. One of nine parallel paradigm studies.

## 1. The paradigm (precise semantics)

A **T-R sequence** (Nilsson 1994) is an ordered list of condition → action rules:

```
K1 → a1      (K1 = the goal condition, a1 = nil)
K2 → a2
...
Km → am      (Km usually T — the catch-all)
```

The semantics differ from a production system in three load-bearing ways:

1. **Continuous evaluation.** All conditions are (conceptually) evaluated
   continuously against sensory input and a world model — Nilsson's "circuit
   semantics": execution builds circuitry, not a read-compute-write loop. The
   practical implementation he used is a LISP `cond` re-executed after every
   short action increment — i.e. discrete sampling abstracted as continuity,
   legitimate whenever the environment's pace is slow relative to evaluation
   (his analogue of ESTEREL's synchrony hypothesis).
2. **First-true-wins, durative actions.** The action of the *first* (shallowest)
   true condition runs. Actions are **durative** — they continue indefinitely
   while their condition remains the first true one, and terminate the instant
   it isn't. Action switching is not programmed; it falls out of re-evaluation.
3. **The regression property.** Each `Ki` (i > 1) is the *regression* of some
   higher condition `Kj` (j < i) through `ai`: executing `ai` long enough, all
   else being equal, makes `Kj` true. A sequence is **complete** if `K1 ∨ … ∨ Km`
   is a tautology, and **universal** if it is complete and satisfies regression.
   A universal T-R sequence provably achieves `K1` absent persistent
   interference — and, crucially, gets **robustness and opportunism for free**:
   a setback drops execution to a deeper rule which re-climbs; a serendipitous
   world change jumps it to a shallower rule with no extra code.

Rules may take run-time-bound parameters whose values are *continuously
recomputed* (`goto(loc)` tracks a moving `loc`), and actions may themselves be
T-R programs, including recursively (`amble` calls itself with a computed
waypoint). In hierarchies, **conditions at all levels stay under evaluation**: a
higher-level rule firing tears down the entire subtree of "circuitry" below it
(garbage-collected the moment it is no longer energized). T-R **trees**
generalize sequences: execute the arc out of the shallowest true node; a fixed
tie-break rule reduces a tree to a sequence.

Nilsson explicitly observed **homeostatic behavior**: a Botworld robot whose
goal is satisfied is *inactive*; when the world violates the goal it reactivates
and persists until the goal is re-achieved. Maintenance goals are just T-R
programs whose top rule keeps being re-satisfied. He also recorded the costs:
most condition evaluations are irrelevant to the situation at hand ("trading
computing time for ease of programming"); debugging is hard *because* the
robustness masks bugs until they compound in hierarchies; a sustaining
condition must be no more restrictive than necessary or the action undercuts
itself; and actions that write directly to the world model risk positive-feedback
instability.

**Follow-on work** sharpened three things:

- **Triple-tower architecture** (Nilsson 2001): a *perception tower* of rules
  derives increasingly abstract predicates from raw percepts; they land in a
  *model tower* kept faithful by truth-maintenance; model predicates energize a
  loose hierarchy of T-R programs in the *action tower*. The doctrine: guards
  read a curated, deterministic belief store, never raw sensation — and the
  sense-model-act cycle is quiescent exactly while the goal is perceived
  satisfied.
- **TeleoR** (Clark & Robinson, ~2012–): a typed, higher-order industrial
  descendant. Guards are QuLog queries against a **Belief Store** atomically
  updated by separate percept and message threads; re-evaluation of the whole
  call stack of procedures happens after each atomic update. It adds rule forms
  Nilsson lacked — `Guard until UCond ~> A` (commit to A even if a higher rule
  becomes fireable, until UCond), `Guard while WCond ~> A` (keep A alive under a
  weaker sustaining condition), and `while…until` — precisely to damp
  **chattering** between rules. It adds multi-tasking: *task-atomic procedures*
  acquire declared resources with a starvation-proof wait queue, and the
  **stable sub-goal** concept (Benson & Nilsson) governs what a task must have
  achieved before releasing resources so a peer can't undo it.
- **Formal semantics** (Dongol, Hayes, Robinson 2014): a Duration-Calculus-style
  interval logic gives T-R programs real-time semantics; **rely/guarantee**
  reasoning makes environment assumptions explicit — progress is provable only
  *relative to a rely condition* (e.g. "the environment does not perpetually
  snatch cans from the gripper"), and their progression theorem *derives* the
  rely condition a program needs. Guards must be **non-Zeno** (not chatter
  infinitely within an interval), which is itself an environment assumption.
  They also formalize the *effective guard*: rule i's real firing condition is
  `Ki ∧ ¬K1 ∧ … ∧ ¬K(i−1)` — the negations of everything above.

## 2. Primary sources

Read in full:

- Nilsson, *Teleo-Reactive Programs for Agent Control*, JAIR 1 (1994) —
  https://arxiv.org/pdf/cs/9401101 (full text read; all §1–7 semantics,
  implementation, and future-work caveats cited above are from it).

Read in substantial excerpt:

- Clark & Robinson, *Concurrent Task Programming of Robotic Agents in TeleoR*
  — https://ceur-ws.org/Vol-1875/intro1.pdf (rule forms, belief-store
  architecture, task-atomic resources, stable sub-goals).
- Dongol, Hayes & Robinson, *Reasoning about Goal-Directed Real-Time
  Teleo-Reactive Programs*, Formal Aspects of Computing 26:3 (2014) —
  https://bura.brunel.ac.uk/bitstream/2438/9747/1/Fulltext.pdf (interval
  semantics, rely/guarantee, non-Zeno guards, progress theorems).

Consulted (abstract + secondary discussion):

- Nilsson, *Teleo-Reactive Programs and the Triple-Tower Architecture*, ETAI 5
  (2001) — https://ep.liu.se/ej/etai/2001/006/
- QuLog/TeleoR reference manual & user guide —
  https://staff.itee.uq.edu.au/pjr/HomePages/QulogHome.html
- Clark & Robinson, *Robotic Agent Programming in TeleoR* (ICRA) —
  http://www.doc.ic.ac.uk/~klc/icra.pdf

## 3. Mapping to LLM agentic loops

**The tick is Nilsson's cond loop.** Alchemy's kernel re-evaluates the turn
effect before *every* model sampling and rebuilds the toolkit from that tick's
mentions. This is exactly Nilsson's discrete-sampling implementation of
continuous evaluation: one sampling step is the "short action increment," and
the turn effect is the `cond`. The synchrony assumption holds a fortiori — a
deterministic Effect over `AI.local` state is instant relative to a model call.

**A stance is a durative action.** The rendered prose + toolkit under which the
model samples is not a discrete act; it *persists across ticks while its
condition remains the operative one* and is torn down the tick it isn't
(mention = presence; the toolkit is rebuilt every tick). The kernel's
situation-diff is T-R's action switching. The correspondence is tight enough to
be a definition: **an alchemy stance is a durative action whose "motor" is an
LLM sampling loop, and a charter is a T-R program whose rules are prose
branches.**

**What regression translates to.** T-R's guarantee — each action, run long
enough, establishes a strictly shallower condition — cannot be *proven* for a
stance, because the effector is stochastic and some conditions are judged, not
sensed. It translates instead into three weaker but real artifacts:

1. **A design obligation**: every stance must *name its exit* — the condition it
   exists to establish (triaging exists to establish `readiness judged`;
   parked exists to establish `gaps closed`). A stance with no nameable exit is
   either the homeostatic top rule or a bug.
2. **An eval property**: from a state where rule i fires, drive the run and
   assert some rule j < i fires within N samplings. This is Nilsson's proposed
   verifier ("check the regression property and note lapses") made empirical.
3. **A rely condition** (Dongol-Hayes): progress claims are meaningless without
   stated environment assumptions — "the author eventually replies," "CI
   terminates," "the model calls `await_author` when blocked." Charters should
   carry their rely conditions as documentation and as eval preconditions.
   The third rely is new to LLM-T-R: *the model itself is part of the
   environment* for guard purposes, since guards read locals the model writes.

**Ordering as authoring discipline.** T-R's list order does two jobs: it
resolves guard overlap deterministically (the effective guard of rule i
includes ¬ of everything above), and it encodes the goal gradient (shallowest =
closest to done). Alchemy's free-form ternaries do neither — with two phases
the ternary *is* a 2-rule T-R program, but at five phases with overlapping
conditions the smuggled state machine has no completeness check and no
priority story. T-R says: make the list explicit, goal-most rule first,
catch-all last, and get completeness by construction (the `T →` rule) rather
than by hoping every `Match` is exhaustive.

**Perpetual processes are homeostats — and the theory blesses them.** A
universal T-R program has no exit; termination is external. Nilsson's robots
idle while the goal holds and reactivate when the world breaks it — precisely
alchemy's park-at-quiescence / wake-on-steer / settle-from-outside loop. In
fact every alchemy charter already has an *implicit kernel-intrinsic top rule*:
`quiescent → park (nil)`. "Charters have no exit conditions; the world outranks
the org's beliefs" is not a deviation from T-R — it is T-R's normal case. What
T-R adds is the vocabulary: a bounded run is an *achieve* program (top rule's
condition is the goal), a perpetual process is a *maintain* program (top rule
is homeostatic), and both are the same formalism.

**Who evaluates conditions.** T-R and especially the triple tower are adamant:
guards read a deterministic, truth-maintained model, never raw sensation, and
*judgment happens in actions, which then write facts the guards read*. The
alchemy pattern in `issues.ts` already conforms: "is this issue READY?" is
judged by the model *inside the triaging stance*, and the judgment is
materialized as a deterministic fact via `awaitAuthor` (`phase.set`), which the
next tick's guard reads. This is the TeleoR Belief Store with three feeds:
world events (percepts, via `steer`), model-written locals (remembered
beliefs, via tools), and the transcript (which T-R has no analogue of).
Nilsson's positive-feedback warning applies to the middle feed — the model
writes state that changes what the model sees — but the mitigation is already
structural: writes go through explicit, named tools that appear in the
transcript, and TeleoR-style hysteresis (below) can bound oscillation.

**Hierarchy is where the models genuinely diverge.** A T-R action that is a
T-R program keeps *all* levels' conditions live; the parent can redirect or
tear down the child the instant a shallower parent guard fires. Alchemy's
`dispatch` is the opposite: admit + await quiescence — a *suspending
subroutine call*, which is the exact construct Nilsson built T-R to escape
("the calling program is suspended until the called program returns… and can
regain control only through interrupts explicitly provided by the
programmer"). Today, if an issue closes while the Engineer is mid-run, the
Issues run gets settled but the dispatched Engineer run is orphaned labor.
T-R's prescription: child work is *energized by* the granting rule and must be
revocable when that rule stops firing.

**Cost discipline.** Nilsson names T-R's main limitation: most condition
evaluations are irrelevant — compute traded for programmability. In the LLM
setting the trade inverts favorably: guard evaluation (deterministic Effects)
is ~free; *sampling* is the expensive durative action; and the frozen-head +
situation-diff design already ensures a stance switch costs one small user
message, not a re-prompt. The T-R rule to import is the boundary itself:
**guards never sample**. A turn effect that calls the model to decide which
prose to render collapses the two-level structure (and the cost model) —
judgment belongs in actions.

## 4. Comparison with alchemy's charter/stance/kernel model

**Already T-R in disguise:**

- Per-sampling turn re-evaluation = discrete-sampled continuous guards
  (Nilsson's own implementation strategy).
- Phase ternary in `issues.ts` = a 2-rule T-R program with durative
  prose-actions; `awaitAuthor`/`resumeTriage` are the belief-store writes that
  move between rules.
- Park/wake/settle = the homeostatic top rule, kernel-intrinsic.
- Mention-is-presence toolkits rebuilt per tick = de-energized circuitry
  garbage-collected; a tool outside the firing rule does not exist this tick.
- Capability-by-omission in the R channel is something T-R never had but is
  entirely compatible: which *actions a rule may take* is a static, typed fact.

**Divergences, and what Nilsson would predict breaks at scale:**

1. **No ordering/completeness discipline.** Free-form ternaries don't state
   priorities or prove coverage. Prediction: as charters grow past ~3 phases,
   guard overlap resolves accidentally (whichever branch the ternary tree hits
   first) and incompleteness surfaces as a tick whose stance says nothing about
   the actual situation — at which point the model improvises, unaudited. This
   is the "state machines smuggled into prose" worry, and T-R's answer is the
   decision list.
2. **No regression bookkeeping.** Nothing names what each stance is *for*, so
   nothing detects a run livelocked at rule i (the LLM analogue of an action
   that never achieves its normal effect). Prediction: perpetual
   triage↔parked oscillation, or a stance that "works" in the transcript while
   establishing nothing — invisible without per-rule transition statistics
   (Nilsson proposed exactly these statistics for pruning).
3. **No commitment/hysteresis.** Nilsson flagged hunting; TeleoR grew
   `until`/`while` rules for it. Alchemy's phase flips are unbounded — a
   chatty author (or a flighty model) can flip `awaiting-author` per steer.
   Non-Zeno guards are an *assumption* the current design makes without
   stating.
4. **Suspending dispatch.** The one structural anti-T-R feature (§3). At scale
   — many concurrent runs, deep delegation — orphaned and stale delegate work
   is a durability and cost leak, and the parent's inability to reassert
   control is the exact failure mode T-R was invented against.
5. **Frozen head vs. rule equality.** T-R rules are peers; alchemy's first tick
   freezes *one branch's* prose into the byte-stable head, and every other
   stance forever arrives as a situation message. That's a cache-driven
   asymmetry with a semantic shadow: the model permanently sees rule-1 prose
   as "the instructions" and other rules as amendments. (An alternative exists
   — see Open Questions.)
6. **Concurrent-run interference.** Runs are serial per key, but many runs
   share world state and shared authorities (merge, deploy). TeleoR's
   task-atomic resources and stable sub-goals have no alchemy counterpart yet.

## 5. Steal / adapt / reject

### Steal

**S1 — The decision-list combinator.** Give charters T-R shape without leaving
prose: an ordered list of guarded stances, first-true-wins, catch-all required
(completeness by construction), goal-most rule first. Guards are deterministic
Effects (type them so they cannot sample).

```ts
// AI.stances: ordered rules, first true guard wins; the final
// AI.otherwise is required — completeness by construction.
const charter = Effect.gen(function* () {
  const phase = yield* AI.local<"triaging" | "awaiting-author">("triaging");
  const awaitAuthor = AI.Tool("await_author")`…`(() => phase.set("awaiting-author"));
  const resumeTriage = AI.Tool("resume_triage")`…`(() => phase.set("triaging"));

  return AI.stances(
    AI.when(Effect.map(phase.get, (p) => p === "awaiting-author"))({
      establishes: "gaps closed → triaging",   // regression annotation (S2)
    })`This issue is parked on its author. Judge their latest reply:
       when it closes the gaps, ${resumeTriage}; otherwise ask again
       with ${Comment} — never re-ask an answered question.`,
    AI.otherwise({
      establishes: "readiness judged: parked or handed to Engineer",
    })`Every ${GitHub.IssueOpened} is checked for prior art with
       ${SearchIssues}… ${awaitAuthor} parks the issue on them.
       A ready issue is handed to ${Engineer}.`,
  );
});
```

`AI.stances` compiles to exactly what the ternary compiles to today (a turn
effect returning one Fragment), so it is sugar — but sugar that makes ordering,
completeness, and the effective-guard semantics (`¬` of rules above) explicit
and machine-visible. It also unlocks S2 and the head alternative in §6.

**S2 — Regression annotations + progress evals + rely conditions.** Each rule
carries `establishes:` (which shallower condition its stance works toward) and
each charter documents its relies ("author replies," "CI terminates"). The test
harness gets a progression assertion: seed a run into rule i's guard, drive it,
assert some rule j < i fires within N samplings — Nilsson's verifier as an
eval. Per-run rule-transition statistics (which rule fired, per tick) are cheap
to record once stances are a list, and directly expose livelock and dead rules.

**S3 — The homeostatic reading of perpetual processes.** No change — the
current park/wake/settle loop *is* T-R's maintenance case, and "charters have
no exit conditions" is theoretically well-founded. Write it down as doctrine so
nobody "fixes" it: bounded runs and perpetual processes are one formalism
differing only in whether the top rule's condition is achievable or maintained.

**S4 — Guards never sample.** Turn effects stay deterministic; model judgment
happens inside stances and is materialized into locals via tools before it can
steer a guard. Enforceable at the type level (exclude `LanguageModel` from a
turn's R) and already the de-facto pattern.

### Adapt

**A1 — Revocable delegation (T-R hierarchy, softened).** Full T-R semantics —
interrupt the child the instant a shallower parent guard fires — is wrong for
expensive, non-idempotent LLM work. Adapt to *structured revocation*: a
dispatched run is scoped to the dispatching run; parent `settle` interrupts
in-flight delegate work; parent guard changes are checked at the *child's
sampling boundaries* (the natural safe points), not preemptively.

```ts
// dispatch acquires the child run inside the parent run's scope:
// parent settled ⇒ child interrupted; optionally, revoke when the
// granting stance stops rendering the delegate.
handlers.dispatch = (params) =>
  delegates.get(params.agent)!
    .dispatch(params.task)
    .pipe(Effect.raceFirst(
      Effect.as(Deferred.await(run.settled), { revoked: true }),
    ));
```

**A2 — Hysteresis / commitment (TeleoR `until`/`while`).** Add optional
commitment to rules or to phase-writing tools: a `minTicks`/`until` on
`AI.when`, or a dwell enforced by the tool that flips the phase. This bounds
chattering (the non-Zeno assumption made real) at trivial cost.

**A3 — Belief-store doctrine (triple tower).** State the three-feed model
explicitly in AGENTS-level docs: world events and model-written locals are the
belief store guards may read; the transcript is the model's private context,
never a guard input. Judgment→tool→fact→guard is the only sanctioned path for
LLM-judged conditions.

**A4 — Stable sub-goals for shared authority (TeleoR multi-tasking).** When
concurrent runs contend for a shared, serialized authority (merge, deploy,
release), adapt task-atomic procedures: an Effect-level resource lock acquired
for the duration of a stance's critical work, released only at a *stable*
point (a merged PR, not a half-rebased branch). Lower priority; becomes real
when run counts grow.

### Reject

- **Provable universality as a gate.** Regression for stochastic effectors and
  judged conditions is an eval target, not a theorem. Duration-calculus-style
  verification (Dongol-Hayes) is the wrong cost/benefit here; steal only its
  rely/guarantee *vocabulary*.
- **Pure reactivity / memorylessness.** T-R agents carry no history beyond the
  model tower. Alchemy's transcript is load-bearing (it *is* the model's
  working memory and the prompt-cache asset). Do not try to make stances the
  only state.
- **T-R trees with cost heuristics.** Shallowest-true-node search over
  alternative action paths is planner territory; a linear decision list
  covers the charter use case.
- **Mandatory migration.** A static charter, or a 2-phase ternary, is already a
  degenerate T-R program. `AI.stances` should be the idiom for ≥3-phase
  charters, not a required form.

## 6. Open questions

1. **Should the head render the whole program?** Today the first tick's branch
   freezes as the head and every other stance arrives as situations. With
   `AI.stances`, an alternative becomes available: render *all* rules into the
   head (byte-stable, cache-perfect, and the model sees the full goal gradient
   the way a T-R programmer reads a program), and inject only "rule i is now
   active" as the situation. This is more faithful to T-R (rules are peers),
   strictly better for caching, but exposes inactive-branch prose to the model
   every tick — does visible-but-inactive prose help (the model anticipates
   transitions) or hurt (it role-plays rules that aren't firing)? Empirical.
2. **Who owns giving up?** T-R has no failure concept — an incomplete program
   stalls silently. Bounded runs need a give-up rule. The T-R-consistent
   answer is a *deterministic budget guard* (ticks, cost, wall-clock) high in
   the list whose stance is "wrap up and report failure" — not a model
   judgment. But budgets interact with relies (a slow author isn't a failure).
   What's the budget vocabulary?
3. **Chattering bounds.** What is the non-Zeno budget — max phase transitions
   per run before escalation to a human or a supervising process? A2 gives the
   mechanism; the policy is open.
4. **Learned regression.** Nilsson proposed pruning rules by firing statistics.
   With rule-transition telemetry (S2), can charters be *audited* automatically
   — dead rules flagged, livelocking rules escalated, and even rule order
   tuned from observed transition frequencies?
5. **Hierarchy depth.** T-R re-evaluates all levels every tick. With A1's
   boundary-checked revocation, how deep can delegation nest before staleness
   between a root guard change and a leaf's next sampling boundary becomes a
   correctness issue (e.g. an Engineer's spawn still editing after the issue
   closed)? Is there a `steer`-based "reconsider" signal cheaper than
   revocation?
