# Behavior Trees and Reactive Robot Control

Research memo for the Alchemy AI charter/stance/kernel design. Topic: Behavior Trees (BTs) in games and robotics, Brooks' subsumption architecture, the BT-vs-FSM-vs-TR comparison literature, and the recent LLM+BT hybrids — and what each says about our model of perpetual, goal-directed agentic loops.

---

## 1. The paradigm — precise semantics

A **Behavior Tree** is a directed rooted tree whose internal nodes are *control-flow* nodes and whose leaves are *execution* nodes. Execution is driven by a **tick**: a signal emitted from the root at some frequency (robotics: 10–1000 Hz; games: per frame) that propagates down the tree according to the control nodes' routing rules. Every ticked node returns one of three statuses to its parent: `Success`, `Failure`, or `Running`. This three-valued return, propagating *up* while ticks propagate *down*, is the whole trick.

**Control nodes** (Colledanchise & Ögren's canonical set):

- **Sequence (`→`)** — ticks children left to right. Returns `Failure`/`Running` the moment a child does; returns `Success` only when *all* children have succeeded. Logical AND with ordering.
- **Fallback / Selector (`?`)** — ticks children left to right. Returns `Success`/`Running` the moment a child does; returns `Failure` only when all children have failed. Logical OR with *priority* ordering — the canonical "try the best thing; failing that, the next best."
- **Parallel** — ticks all children every tick; succeeds when M of N have succeeded, fails when N−M+1 have failed.
- **Decorator** — one child, arbitrary policy over its statuses and tick routing: inverters, retry-N-times, timeout, cooldown, "max one activation," rate limiters.

**Execution nodes**:

- **Condition** — instantaneous predicate over world/blackboard state; returns `Success` or `Failure`, *never* `Running`.
- **Action** — does work over time; returns `Running` while in progress, then `Success`/`Failure`.

**Reactivity is a consequence of memoryless re-ticking.** In the default ("reactive") semantics, every tick re-evaluates the tree *from the root*. A Sequence re-checks its earlier condition children even while a later action child is `Running`; a Fallback re-checks higher-priority branches while a lower one runs. So if a higher-priority guard flips true — battery low, enemy sighted, CI went red — the very next tick routes execution to that branch, and the running subtree is **preempted** (in BehaviorTree.CPP, explicitly `halt()`ed; in the formal semantics, simply no longer ticked). RUNNING is thus first-class dormancy: an action can be "in progress" for arbitrarily long, costing one status check per tick, preemptible at every tick boundary.

**Memory vs memoryless nodes.** Sequence/Fallback "with memory" (`*` variants) remember which child last returned and skip re-ticking earlier ones — trading reactivity for not re-executing side effects. Colledanchise & Ögren show memory nodes are syntactic sugar: expressible in memoryless trees with explicit state conditions. This trade — *does the guard get re-checked while the subtree runs?* — is the central authoring decision in every real BT, and it will reappear below as the central question for charters.

**Formal results** (the reason BTs are more than a diagram convention). Colledanchise & Ögren give a state-space semantics (a BT is a hybrid dynamical system: a function from state to action plus the return-status machinery) and prove:

- **Modularity/composability**: a subtree is behaviorally a black box — it has exactly the same interface (tick in, status out) as a leaf, so properties proven of subtrees (safety: never enters bad states; **Finite-Time Success (FTS)**: succeeds within bounded time from a region of attraction) are *preserved under composition* by Sequence/Fallback with stated side conditions. You can reason about a million-node tree one subtree at a time. FSMs have no analog: a transition is a one-way `goto`, and adding a state can require touching O(n) transitions.
- **BTs generalize**: (1) *sequential behavior compositions*, (2) the **subsumption architecture** — a subsumption stack is exactly a Fallback list with the higher layers first: each layer becomes `Sequence(layer-active-condition, layer-action)`, and suppression is just tick priority; (3) *decision trees* — a decision tree is a BT whose actions never return `Running`; and (4) the **teleo-reactive paradigm** (IROS 2016): a TR program `K₁→a₁ … Kₙ→aₙ` (ordered production rules, conditions continuously evaluated, first true condition's durative action runs) transcribes to `Fallback(Sequence(K₁,a₁), …, Sequence(Kₙ,aₙ))` under memoryless semantics, where continuous evaluation = ticking. Moreover **Universal TR programs** (those with the regression property — each action's completion establishes the condition of a higher rule, guaranteeing goal achievement) are a *special case* of FTS BTs. So the T-R agent's paradigm embeds in this one: **BT is the strictly more general authoring surface** — it adds sequences with memory, parallelism, decorators, and black-box subtree modularity that flat TR rule lists lack. (The synthesis should reconcile there: adopting "BT-shaped combinators" subsumes adopting "TR rule lists"; the TR form is the special case where every branch is `when(cond, action)` at one level.)

**Subsumption, on its own terms** (Brooks 1986). Layers of *competence* (0: avoid collisions; 1: wander; 2: explore; …), each a network of small asynchronous state machines wired by low-bandwidth message wires, **no shared memory, no central world model**. A higher layer subsumes a lower one by *suppressing* its inputs or *inhibiting* its outputs at wire taps — the lower layer keeps running, unaware. Two doctrines matter beyond the wiring: (a) **incremental competence** — level 0 is debugged and *never altered*; each new layer adds capability without destabilizing what works; if a higher layer crashes, the lower ones still produce sensible (if less ambitious) behavior; (b) **"the world is its own best model"** ("Intelligence Without Representation") — don't maintain internal state that mirrors the world; sense the world when you need to know.

**Games practice** (Isla, GDC 2005, "Handling Complexity in the Halo 2 AI" — the origin of the term's popularity). Halo 2's tree is a behavior DAG of ~50 behaviors under **prioritized-list** parents (= Fallback) with binary relevancy checks (= conditions). Three inventions foreshadow everything later: **behavior masking** (bitvector execution-conditions gate whole subtrees on/off — "locking and unlocking large portions of the tree, thus modifying its fundamental structure"); **impulses** (free-floating event triggers that redirect execution to another branch — event-driven preemption rather than per-tick polling of rare conditions, via *stimulus behaviors*); and the **memory problem** — persistent per-behavior state is unaffordable, so only *running* behaviors keep state, and everything that must persist across behavior switches (last-grenade-throw time, target knowledge) lives in a separate knowledge model outside the tree. "Take smarts out of the behavior and put it in the knowledge model."

**Robotics practice** (BehaviorTree.CPP v4 / ROS 2 Nav2). Trees in XML; data flows through a **blackboard** with typed ports; long-running actions are `StatefulActionNode`s (`onStart`/`onRunning`/`onHalted`) — the `onHalted` callback is where preemption cleanup lives (cancel the ROS action, stop the motor). Nav2's navigator is a BT: `Fallback(Sequence(ComputePath, FollowPath), RecoverySequence(ClearCostmap, Spin, Wait, Backup))` with retry decorators — recovery-on-failure expressed *in the tree*, not in the leaves. Two production caveats worth stealing as warnings: `ReactiveSequence` only tolerates **one** asynchronous child (its first N−1 children must be synchronous conditions — issue #573), and halting a running child *after* starting its replacement causes real race conditions (issue #1031, open since 2025) — preemption ordering is subtle even for the reference implementation.

**BT vs FSM, honestly.** The literature's verdict: FSM transitions are gotos — control is *handed off* and the source state must know its destination; N states can need O(N²) transitions; reuse of a state in two machines drags its transition spaghetti along. BTs replace the goto with a function call: tick down, status up, caller decides what's next. The cost, equally honest: BTs re-evaluate conditions every tick (Halo's masking exists because that got expensive); "what is the system doing right now" is a path through a tree rather than a single state name, which practitioners find harder to log and debug; and dithering (A preempts B preempts A…) needs hysteresis added by hand. FSMs remain right when states are few and transitions are the *point* (protocol handshakes). BTs win when behaviors are many, priorities are the point, and reuse matters.

**LLM+BT hybrids (2024–2026).** Two distinct genres:

1. **LLM generates the BT** (plans-as-trees): LLM-BT (arXiv 2404.05134) has ChatGPT produce task steps parsed into a BT, updated as the environment changes; BETR-XP-LLM (arXiv 2409.13356) invokes the LLM *only on failure* to expand the tree with a missing precondition subtree, permanently repairing the policy; Code-BT (IJCAI 2025) generates code whose control flow is extracted into a BT; LLM-HBT (arXiv 2510.09963) does closed-loop failure→reason→insert-subtree across heterogeneous robot fleets; the RAS 2025 social-robot paper adds a "Failure Interpreter" that patches trees or asks the human. Common shape: **the LLM is the planner; the BT is the executable, inspectable, reactive artifact**; failures re-invoke the LLM. The pitch is always the same — LLM calls are slow, expensive, and unaccountable, so keep them off the hot path and keep the executed policy verifiable.
2. **LLM as leaves** (Dendron, arXiv 2404.07439, the most relevant to us): action nodes are model generations; condition nodes are `CompletionCondition`s — score the log-probabilities of a closed set of completions ("is the human trying to end the conversation? yes/no") and map the argmax through a designer-supplied function to `Success`/`Failure`. The tree stays deterministic code; the *judgments* are model-evaluated at designated points, cheaply (one forward pass, no sampling), with the closed answer set making the judgment auditable. Dendron explicitly leans on the Colledanchise/Ögren composition theorems to wrap LLM subtrees in deterministic guards for safety guarantees.

## 2. Primary sources

What I actually read: full text of the Halo 2 GDC proceeding and Brooks 1986 (key sections); abstracts plus substantial excerpts of the two Colledanchise/Ögren theorem papers and the book; BehaviorTree.CPP tutorial/API docs and the two cited GitHub issues; Dendron paper excerpts and API docs; abstracts/excerpts of the four LLM-BT-generation papers.

- Colledanchise & Ögren, *Behavior Trees in Robotics and AI: An Introduction* — <https://arxiv.org/abs/1709.00084> (book form: CRC Press, doi:10.1201/9780429489105).
- Colledanchise & Ögren, *How Behavior Trees Modularize Hybrid Control Systems and Generalize Sequential Behavior Compositions, the Subsumption Architecture, and Decision Trees*, IEEE T-RO 2017 — <https://doi.org/10.1109/tro.2016.2633567>.
- Colledanchise & Ögren, *How Behavior Trees Generalize the Teleo-Reactive Paradigm and And-Or-Trees*, IROS 2016 — <https://doi.org/10.1109/iros.2016.7759089>.
- Isla, *Handling Complexity in the Halo 2 AI*, GDC 2005 — <https://www.gamedeveloper.com/programming/gdc-2005-proceeding-handling-complexity-in-the-i-halo-2-i-ai>.
- Brooks, *A Robust Layered Control System for a Mobile Robot*, 1986 — <https://people.csail.mit.edu/brooks/papers/AIM-864.pdf>; *Intelligence Without Reason* — <https://bitsavers.org/pdf/mit/ai/aim/AIM-1293.pdf>.
- BehaviorTree.CPP — <https://www.behaviortree.dev/docs/tutorial-basics/tutorial_04_sequence/>; ReactiveSequence constraint: issue #573; halt-race: issue #1031.
- Kelley, *Behavior Trees Enable Structured Programming of Language Model Agents* (Dendron) — <https://arxiv.org/abs/2404.07439>; docs <https://richardkelley.io/dendron/>.
- LLM-BT — <https://arxiv.org/abs/2404.05134>; BETR-XP-LLM — <https://arxiv.org/abs/2409.13356>; Code-BT — <https://www.ijcai.org/proceedings/2025/980>; LLM-HBT — <https://arxiv.org/abs/2510.09963>; *Behavior tree generation and adaptation for a social robot control with LLMs*, RAS 2025 — <https://doi.org/10.1016/j.robot.2025.105165>.

## 3. Mapping to LLM agentic loops

The structural correspondence with alchemy's kernel is uncannily tight, which is itself a finding: the charter/stance model independently reinvented the BT execution discipline with different vocabulary.

| BT concept | Alchemy today |
|---|---|
| tick | turn re-evaluation before every sampling (`actorTick`) |
| tree evaluation → active leaf | turn effect → rendered stance (one branch's prose) |
| action node | the model itself, given a stance; sampling is the action executing |
| `Running` | tool-call loop continuing; and, at larger scale, a **parked run** awaiting the world |
| `Success`/`Failure` of the root | `settle` — but by the *world*, not the tree (see §4) |
| conditions | branch predicates over `AI.local` state in the turn effect |
| Fallback over guarded branches | hand-rolled ternaries in the charter (`phase === "parked" ? … : …`) |
| behavior masking (Halo) | mention-is-presence: an unrendered tool is not in the toolkit this tick |
| impulses / stimulus behaviors (Halo) | `steer`/`settle` wired by the Process Layer — event-driven wake, no polling |
| blackboard / knowledge model | `AI.local` (per-run) + the world itself (GitHub is the knowledge model) |
| subtree | `Skill` (prose + tools under one name), nested `AI.prose` fragments |
| tick frequency | **none while parked** — event-driven, which is strictly better for our cost model |

The load-bearing questions, answered from the literature:

**(a) Is per-sampling turn re-evaluation a tick, and are charter branches a hand-rolled Fallback?** Yes, exactly — the `Issues` charter *is* `Fallback(Sequence(phase=awaiting-author?, parked-stance), triage-stance)` in memoryless semantics, and the kernel's before-every-sampling re-evaluation is precisely the reactive re-tick that makes higher branches able to seize control. Two disanalogies matter. First, **a parked run does not tick**: BTs tick on a clock; alchemy ticks on *events* (steer/send/settle wake the loop). This is Halo's stimulus-behavior insight taken to its conclusion, and for a system whose tick costs a model sample rather than a microsecond, event-driven ticking is the correct choice — keep it. But it has a corollary: any behavior that should trigger on *time* (deadline, cooldown, "nudge the author after 3 quiet days") currently has no tick to ride on. BT decorators assume a clock; alchemy needs a timer source that manifests as a steer. Second, **the phase local is a memory node**: once `phase = "awaiting-author"`, the triage branch is not re-checked until a *tool call* moves the phase back. In BT terms alchemy's charters default to Sequence-with-memory, and reactivity is recovered only where the Layer wires world events into steers. That is the right default for LLM loops (re-running "triage" side effects on every tick would be wrong) but it means **guard re-evaluation is a design obligation on the Layer**, not a property of the engine — worth making explicit in the framework's doctrine.

**(b) RUNNING as first-class, and preemption.** An LLM run parked on the author for days is exactly an action node returning `Running` — BTs handle this with zero anxiety: the node costs one tick-visit; a higher-priority branch can preempt at any tick boundary. The BT lesson for steers is sharper than "deliver input": in a BT, a preempting branch doesn't *ask* the running subtree to reconsider — the tree's structure **routes execution away** and the subtree is halted. Alchemy's current answer to "CI went red while parked on review" is a steer whose text the model weighs — *soft* preemption, model-judged. Alchemy already has one *hard* preemption primitive nobody names as such: **toolkit revocation** — a branch flip removes tools from the next tick regardless of the model's opinion. The literature says both matter, plus a third: `onHalted` cleanup (BehaviorTree.CPP's races in issue #1031 show what happens when replacement starts before the halted branch cleans up). Recommendation: make guard-driven branch flips a code-level act (the Layer or a combinator sets the phase local on the event, *then* steers), so preemption = stance replaced + capabilities revoked + situation injected, with model judgment left only to what genuinely needs judging.

**(c) Subtrees ↔ Skills.** A BT subtree is a black box with a tick/status interface; a Skill is prose + tools behind one name, dormant until activated. The gap: subtrees have *internal control flow*; Skills are static prose. A "reusable way of working with internal phases" (e.g. a Review skill: first pass, then wait-for-fixes, then verify) can't be written as a Skill today — it can only be a whole Agent. The BT lesson is that the composition interface should admit *dynamic* sub-behaviors: let a Skill (or a fragment-valued component) carry its own turn effect and locals, spliced into a host charter. The kernel already evaluates effect-valued splices per tick, so this is close.

**(d) Parallel and Decorators.** Parallel nodes track multiple concerns in one tree. Alchemy's equivalents are (i) multiple prose blocks in one stance — the model attends to several concerns in one transcript, which is what LLMs are *good* at and BTs need machinery for — and (ii) separate keyed runs when concerns need separate transcripts. An engine-level Parallel node would be redundant. Decorators, by contrast, are the single most stealable idea: retry budgets, timeouts, cooldowns, spend caps as **orthogonal wrappers** around a stance rather than prose clauses ("try at most 3 times" written as prose is a wish; written as a decorator it's a fact). They compose because a decorated stance is still a stance, exactly as a decorated subtree is still a subtree.

**(e) Subsumption's lesson for perpetual processes.** A perpetual process is a homeostat, not a task — and Brooks' layering is the right shape for it: a **baseline layer** that is always competent (keep the issue list triaged; answer comments), with **opportunistic higher layers** that suppress it when their conditions hold (a security advisory arrives → drop everything). Layered stances beat a flat phase enum on exactly Brooks' grounds: each layer is separately debuggable, lower layers keep working when higher ones are absent or broken, and adding a layer never edits the ones below. And alchemy already embodies the deeper subsumption doctrine: **the world is its own model** — run state is the GitHub issue, not a mirrored belief store; `settle` comes from the world; "the world outranks the org's beliefs" (Actor.ts) is a direct restatement. Notably the *situation supersedes* mechanism is suppression-flavored already: the latest situation overrides earlier prose on the same matters.

**(f) Condition nodes that are judgments.** The honest split, per Dendron and the failure-driven-planner papers: **conditions that code can check must be checked by code** (CI status, phase, review state — cheap, deterministic, auditable); **judgment conditions get a designated, closed-form model evaluation** (Dendron's CompletionCondition: closed answer set, one scoring pass, explicit mapping to branch choice); and only what genuinely requires open-ended judgment stays in-context. Alchemy's `await_author`/`resume_triage` tool pattern is a *fourth* mode the robotics literature doesn't have: the model evaluates the condition **and materializes its verdict as a state transition through a tool call** — the judgment becomes a recorded, typed act rather than an invisible branch. That is genuinely good design; keep it, and add the Dendron-style *guarded* judgment (a condition combinator that runs a cheap dedicated sample) for conditions that must be evaluated *outside* the run's own transcript — e.g. "is this reply satisfying?" judged without the run's accumulated sympathy for its own position.

## 4. Comparison with alchemy's model

**Where alchemy is already a BT (or better).** Per-sampling re-evaluation = reactive ticking; mention-is-presence = behavior masking; steer/settle wiring = impulses/stimulus behaviors (event-driven, superior for our cost model); locals+world = blackboard+knowledge-model with the memory problem solved the Halo 3 way; Process-Layer-owned settle = the world owns outcomes. On the last point alchemy is *ahead* of naive BT-with-LLM-leaves: in a BT, the leaf reports its own `Success`, and an LLM leaf self-reporting success is exactly the failure mode the LLM-BT papers keep patching (their Failure Interpreters exist because leaf statuses lie). Alchemy's decision that **completion belongs to the world** (`settle` on `PullRequestMerged`, not on the model saying "done") is the single most important divergence and must be preserved through any BT-ification.

**Where alchemy is a hand-rolled, unnamed BT.** Charter branching today is ternaries over locals. At two branches (`Issues`) it's fine. The literature is unambiguous about what happens as this grows: Isla's whole talk is about what 50 behaviors need (masking, impulses, priority schemes as *named, uniform* mechanisms), and the FSM→BT migration in games happened because ad-hoc branching logic stops being auditable. The charter needs its Fallback/Sequence/Decorator vocabulary *named* — not a new engine, just combinators over what exists.

**Where BT determinism fights the model.** Crisp leaf statuses, tick-frequency polling, and tree-owned completion all fight the LLM grain. Prose is alchemy's actual medium — a stance is not an action primitive, it's a *briefing* — and the model's ability to weigh several concerns in one context is a capability BTs spend Parallel nodes and blackboards approximating. The right synthesis is the Dendron direction inverted: Dendron puts LLM leaves in a code tree; alchemy should put a *code-shaped guard structure* under a prose canopy — deterministic guards and decorators choosing **which briefing** the model gets, the model supplying all intra-stance intelligence.

**The T-R reconciliation.** Since BTs strictly generalize TR programs (IROS 2016: TR rule list = memoryless Fallback of guard→action Sequences; Universal TR ⊂ FTS BT), any recommendation from the T-R research thread is expressible in the combinator surface proposed here; the TR form is the flat special case, and its regression-property discipline ("each stance's success should establish an earlier guard") survives as a *design guideline* for charter authors rather than a distinct mechanism.

## 5. Steal / adapt / reject

**STEAL — guarded-stance combinators (the Fallback surface).** Name what charters already do. A thin, kernel-invisible layer: combinators consume `Effect<Fragment>` and return `Effect<Fragment>`; the kernel keeps evaluating one turn effect per tick.

```ts
// AI/Stance.ts — combinators over turn effects; no kernel changes.
// A Guard is an Effect<boolean> over CurrentRun (locals) and world services.
export const when = <R1, R2>(
  guard: Effect.Effect<boolean, never, R1>,
  stance: Effect.Effect<Fragment, never, R2>,
): GuardedStance<R1 | R2> => ({ guard, stance });

// Fallback: first guarded stance whose guard holds; last arg is the default.
export const first = (<Cases extends GuardedStance<any>[], R>(
  ...cases: [...Cases, Effect.Effect<Fragment, never, R>]
) =>
  Effect.gen(function* () {
    for (const c of cases.slice(0, -1) as Cases) {
      if (yield* c.guard) return yield* c.stance;
    }
    return yield* cases.at(-1) as Effect.Effect<Fragment, never, R>;
  })) as First;
```

The `Issues` charter, re-spelled — same semantics, now shaped for growth:

```ts
return AI.first(
  AI.when(ciRed(key), urgentCiStance),          // higher layer, added later,
  AI.when(phase.is("awaiting-author"), parked), // never edits the ones below
  triaging,
);
```

**STEAL — decorators as stance wrappers.** Budgets, retries, cooldowns, deadlines as orthogonal combinators that read/write dedicated locals and can escalate (steer a supervisor, flip a phase) — never prose clauses:

```ts
const triaging = AI.attempts(3, { onExhausted: escalateToHuman })(
  AI.deadline("3 days", { onExpired: nudgeAuthor })(
    triageStance,
  ),
);
```

`deadline` is also where the missing clock enters: the decorator registers a kernel timer whose firing is a self-steer — the event-driven analog of the tick a BT decorator rides on.

**STEAL — the Universal-TR/FTS design guideline** (via the BT⊃TR theorem): author `first(...)` charters so each stance's successful outcome makes a *higher* guard true; that is the checkable shape of "this perpetual process makes progress."

**ADAPT — preemption as code, judgment as judgment.** World events that must override the current stance (CI red, security advisory, author gone hostile) get guards + Layer wiring that set locals *before* steering, so the next tick's stance and toolkit change deterministically; the situation message then *explains* the preemption the model already received structurally. Keep model judgment for conditions that are judgments — via the existing phase-moving-tool pattern, plus a Dendron-style `AI.judge` (closed answer set, cheap dedicated sample, verdict written to a local) for out-of-transcript judgments.

**ADAPT — Skills as subtrees.** Allow a Skill (or a fragment component) to carry init + turn of its own — internal phases, own locals — so "a way of working" with stages composes into any host charter as a black box, the way subtrees do.

**REJECT — a real BT engine.** No tick clock (event-driven wake is strictly better at LLM prices); no `Success`/`Failure` from the model-as-leaf (the world settles runs — keep that); no Parallel node (prose blocks + keyed runs cover it); no blackboard (locals + the world cover it); no XML/graph authoring surface (charters are Effect programs; the combinators above *are* the tree).

## 6. Open questions

1. **Stance reversion vs the frozen head.** If tick 1 freezes branch A into the head, a flip to branch B injects B as a situation — but a flip *back* to A yields an empty situation and no injection, leaving B's (now false) situation as the model's last word. BT semantics (full restatement each tick) has no such gap. Should reverting to head-state inject an explicit retraction situation?
2. **Who owns guard evaluation cost?** Guards run before *every* sampling; guards that call the world (CI status) put I/O on the hot path. Halo's answer was masking bitvectors (precomputed); ours is probably Layer-maintained locals updated by events, with guards reading only locals — worth making doctrine.
3. **Preemption cleanup (`onHalted`).** When a guard flip abandons a stance mid-work (branch open, PR half-written), what runs? A decorator-level `onPreempted` effect? BehaviorTree.CPP's open races suggest ordering (cleanup before replacement stance samples) needs to be a kernel guarantee, not a convention.
4. **Dithering/hysteresis.** Reactive guards invite A↔B oscillation (author replies / CI flickers). BTs add cooldown decorators and Halo added winner-bonus hysteresis; which is idiomatic here?
5. **Skill-as-subtree scoping.** If a Skill carries locals and a turn, do its locals live in the host's run store (shared identity) or a namespaced sub-store (true black box)? The BT answer (blackboard *ports* with explicit remapping) suggests explicit namespacing.
