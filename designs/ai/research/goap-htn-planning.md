# GOAP, STRIPS, HTN, and Utility AI — what the game-AI planning family teaches Alchemy's charter/stance model

Research memo, one of nine informing the agentic-loop design decision. Repo model under discussion: `packages/alchemy/src/AI/` (Kernel, KernelMemory, Prose, Run, Actor, Agent, Process, Skill) and the live charters in `services/alchemy-org/src/` (issues.ts, engineer.ts, pull-requests.ts). All of those were read in full before writing this.

---

## 1. The paradigms — precise semantics

Three architectures, three different answers to "how does an agent decide what to do next." They are frequently conflated; their computational models are disjoint.

### STRIPS (the substrate)

Fikes & Nilsson, 1971. A **world model** is a set of first-order predicate-calculus formulas. An **operator** (action) is a triple: *precondition* (a formula that must be provable in the current model), *delete list*, *add list* (formulas removed/added when the operator applies). A **goal** is a formula to be made provable. Planning is search through the space of world models — STRIPS used means-ends analysis with a resolution theorem prover; the modern framing is state-space search, forward (progression) or backward from the goal (regression). Two details of the 1971 system matter more than the search itself and are usually forgotten:

- **Triangle tables / PLANEX** (Fikes, "Monitored Execution of Robot Plans produced by STRIPS", IFIP 1971): the plan is compiled into a table recording which effects of step *i* are preconditions of step *j*, so an *executor* can check at every step whether the plan's remaining tail is still valid against observed reality — re-executing steps that failed, skipping steps whose effects already hold. Plan **monitoring** is as old as planning itself; the plan was never trusted.
- The world model is **authoritative and observed**, not remembered — Shakey re-derived facts by sensing.

### GOAP (STRIPS made practical, F.E.A.R. 2005)

Jeff Orkin's Goal-Oriented Action Planning ("Applying Goal-Oriented Action Planning to Games", AI Game Programming Wisdom 2, 2003; "Three States and a Plan: The A.I. of F.E.A.R.", GDC 2006). The architecture, precisely:

- **World state as a fixed-size typed blackboard** — an array of ~4-byte slots (`TargetDead: bool`, `WeaponLoaded: bool`, `AtNode: handle`), not open-ended logic. Populated by **sensors** into shared **working memory**.
- **Actions** declared with symbolic preconditions/effects over that array, **plus procedural preconditions** (arbitrary C++ run on demand — e.g. "is there a safe escape path?" runs a pathfind only when the planner considers Flee) and **procedural effects** (activating the action drives the 3-state FSM: Goto/Animate; effects take time, they are not instantaneous assertions).
- **Cost per action**, so **A\*** searches backward from the goal state to the current state over the action graph, preferring cheap plans (OrderPizza cost 2.0 beats BakePie cost 8.0 when both satisfy Hunger).
- **Goal arbitration is separate from planning**: each character carries a *Goal Set*; goals compete for activation by priority/relevance; the planner is invoked only to satisfy the currently winning goal. Characters differ by *Action Set*, not by goal: the soldier, the assassin, and the rat all carry `Patrol` + `KillEnemy`; the rat has no attack actions, fails to formulate any KillEnemy plan, and falls back to Patrol.
- **Replan on invalidation**: when an action fails or a sensor invalidates the plan's assumptions, record the discovered obstacle in working memory and re-plan *taking that knowledge into account* — the famous blocked-door sequence (try door → fails → kick door → fails → dive through window → melee) is nothing but failure-informed replanning.
- Squad behavior in F.E.A.R. was **ad hoc and separate** — an orders layer on top; the apparent flanking/pincer maneuvers were emergent from individual replanning, not planned. Orkin explicitly points at HTN as the right tool for the squad layer.

Orkin's own summary of why: three benefits — (1) **decoupling goals from actions** kills the "mimes and mutants" problem (in NOLF2 every goal embedded its own FSM; a policeman who catches his breath forced a branch into everyone's Chase machine); (2) **layering without manual transitions** ("we can just toss in goals and actions… the A.I. figure out the dependencies themselves"; the counterfactual: NOLF2's late "turn on lights in dark rooms" requirement meant revisiting every goal's FSM, versus adding one `TurnOnLights` action with a `LightsOn` effect and one precondition on `Goto`); (3) **dynamic problem solving** via failure-informed replanning.

### HTN (task decomposition, not state-space search)

Erol, Hendler & Nau formalized HTN planning (1994, "HTN planning: complexity and expressivity" — strictly more expressive than STRIPS; undecidable in general). SHOP2 (Nau et al., JAIR 20, 2003) is the canonical practical planner. The model: the problem is not a goal formula but a **task network**. The domain supplies **operators** (primitive tasks, STRIPS-like) and **methods** — each method is a triple *(task it decomposes, precondition, partially-ordered subtasks)*. Planning is recursive decomposition: pick a method whose precondition holds, replace the compound task with its subtasks, repeat until everything is primitive. SHOP2's distinctive move is **ordered task decomposition**: it plans steps in execution order, so it always knows the concrete current state while evaluating method preconditions — which is what lets preconditions be arbitrarily expressive (logical inference, numeric computation, external calls). Methods are the domain's "standard operating procedures" (Nau's phrase). HTN doesn't invent behavior — it selects and instantiates *encoded expertise*. There is no goal-satisfaction semantics unless you encode it; success is "the task network was decomposed and executed."

### Utility AI (no plan at all)

Dave Mark, *Behavioral Mathematics for Game AI* (2009); Mark & Dill's GDC AI Summit lectures (2010, 2012); the **Infinite Axis Utility System** (Mark & Lewis, GDC 2015; deployed in Guild Wars 2: Heart of Thorns, GameAIPro3 ch. 13). The model: every candidate action carries a set of **considerations** (axes); each consideration normalizes a raw input (distance, health, staleness) to [0,1] through a designer-shaped **response curve**; scores multiply into the action's utility; highest utility wins, every think cycle. There is no search, no lookahead, no plan artifact, no world-state model beyond the inputs. Its virtues: O(actions × considerations) scaling, continuous nuance instead of threshold cliffs, personality by curve-shape, never "stuck" in a behavior. Its vices: no sequencing (multi-step behavior must be smuggled in via considerations like "am I mid-reload"), and score provenance is opaque without tooling.

### The reactive critique (why this family isn't the whole answer)

Agre & Chapman, "Pengi: An Implementation of a Theory of Activity" (AAAI-87): capital-P Planning — a smart Plan-construction phase feeding a dumb Executive — fails on complexity (Chapman 1985 proved conjunctive planning combinatorially explosive), uncertainty (other agents make futures unpredictable), and immediacy ("life is fired at you point blank"). Pengi plays Pengo with **no world model and no plan**: a combinational network maps *deictic, indexical-functional* aspects of the immediate situation (`the-bee-that-is-chasing-me`, `the-block-I-just-kicked`) to actions, with layered **action arbitration** (suggest, overrule, counter-propose) instead of goal search. Routines — apparent loops and strategies — *emerge* from rules interacting with the world and are never represented. Lucy Suchman, *Plans and Situated Actions* (1987), makes the anthropological version of the argument: plans are **resources for** situated action, not programs that determine it; the work of acting is always improvisation against the concrete situation, with plans consulted the way one consults a recipe.

Hold that thought, because Alchemy's stance model is — whether the author intended it or not — a Pengi/Suchman architecture, not a STRIPS one.

## 2. Primary sources

What I actually read, in full or in relevant part, for this memo:

- **Orkin, "Three States and a Plan: The A.I. of F.E.A.R."**, GDC 2006 — read in full. https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf (annotated slide deck: https://web.cs.wpi.edu/~rich/courses/imgd4000-d08/lectures/fear.pdf; GDC Vault: https://www.gdcvault.com/play/1013459/Three-States-and-a-Plan)
- **Orkin, "Applying Goal-Oriented Action Planning to Games"**, AI Game Programming Wisdom 2, 2003, pp. 217–228 — abstract and summary read (book chapter not freely available); its content is subsumed and cited by the 2006 paper. Index: http://www.aiwisdom.com/byresource_aiwisdom2.html
- **Fikes & Nilsson, "STRIPS: A New Approach to the Application of Theorem Proving to Problem Solving"**, IJCAI-2 1971 / AIJ 2(3–4) — read the formulation sections (world models as wffs, operator precondition/add/delete definitions, the room-and-boxes tasks). https://ai.stanford.edu/~nilsson/OnlinePubs-Nils/PublishedPapers/strips.pdf. Plan monitoring companion: Fikes, "Monitored Execution of Robot Plans Produced by STRIPS", IFIP 1971 (cited therein; not independently retrieved).
- **Nau et al., "SHOP2: An HTN Planning System"**, JAIR 20 (2003) 379–404 — read the introduction, method semantics (§3.1.3), and ordered-decomposition sections. https://www.jair.org/index.php/jair/article/download/10362/24790/ (doi:10.1613/jair.1141). Also skimmed Nau et al., "Applications of SHOP and SHOP2", IEEE Intelligent Systems 2005: https://www.cs.umd.edu/~nau/papers/nau2005applications.pdf. (Erol/Hendler/Nau 1994 known from the SHOP2 paper's framing; not independently retrieved.)
- **Agre & Chapman, "Pengi: An Implementation of a Theory of Activity"**, AAAI-87, pp. 268–272 — read in full. https://cdn.aaai.org/AAAI/1987/AAAI87-048.pdf. Agre's thesis (*The Dynamic Structure of Everyday Life*, on deictic representation) skimmed: https://apps.dtic.mil/sti/tr/pdf/ADA205677.pdf
- **Utility AI / IAUS**: Lewis, "Choosing Effective Utility-Based Considerations", GameAIPro3 ch. 13 (the Guild Wars 2 IAUS deployment) — read. http://www.gameaipro.com/GameAIPro3/GameAIPro3_Chapter13_Choosing_Effective_Utility-Based_Considerations.pdf. Dave Mark's IAUS overview: https://www.gameai.com/iaus.php; Mark & Dill GDC lectures per https://en.wikipedia.org/wiki/Utility_system. *Behavioral Mathematics for Game AI* (2009) known secondhand through these.
- **Suchman, *Plans and Situated Actions*** (Cambridge, 1987) — not retrieved; position characterized from the book's well-established thesis and its treatment in the Pengi literature.

## 3. Mapping to LLM agentic loops

The load-bearing observation: **the LLM already is the planner.** Chain-of-thought is plan synthesis; the transcript is working memory; a tool error in the transcript is Orkin's "record the blocked door and re-plan considering it"; the next sampling is the replan. GOAP's Benefit #3 (failure-informed dynamic problem solving) comes for free in an LLM loop — genuinely, not approximately, and F.E.A.R.'s blocked-door sequence is exactly what a competent model does when a tool call fails. So the framework should not build a planner. What remains is everything GOAP needed *around* its planner — and that is the data model:

**(a) World state as a curated blackboard.** GOAP's fixed-size array was a deliberate poverty: one slot per variable forced *attention-selection subsystems outside the planner* (targeting picks THE target; the planner reasons about only it). The LLM analog is the context window, and the lesson is the same — render a small, curated, current world state, not a firehose. Alchemy's kernel already does this: the stance is re-rendered every tick, blocks are set-diffed, and the changed situation is delivered as one superseding message. That IS the blackboard, and the discipline ("full restatement, latest supersedes") is better than most agent frameworks manage. What's missing is any *typed* notion of what the blackboard contains — `AI.local` values and observation splices are opaque prose fodder; deterministic code cannot ask "what does this run currently believe."

**(b) Goals as reified desired-world-states.** In GOAP a goal is data: a desired assignment to blackboard slots, checked by machinery, with relevance/priority deciding *which* goal is active and the planner deciding *how*. In Alchemy today goals live only in prose ("A ready issue is handed to Engineer"), success is whatever makes the model stop calling tools (quiescence), and the only endings are external (`settle`) or crash. There is no machine-checkable "this run achieved its purpose," no giving-up semantics, no budget. This is the single largest gap the planning literature exposes, detailed in §5.

**(c) Actions with declared preconditions/effects.** Alchemy tools have schemas (Parameters) but no declared effects and no declared preconditions. Note, though, what the org already does: the merge tool "refuses without an approved review" (pull-requests.ts) — that is *exactly* Orkin's procedural precondition, a guard run on demand inside the action. The runtime half of GOAP's action model is present and idiomatic. The declarative half is absent, and its value in an LLM system is **not search** (the model doesn't need A*) but: legibility (docs and prompts derived from declarations), monitoring (a postcondition the kernel can check after the call), and static analysis (does any rendered branch of this charter grant a tool whose effect can satisfy the charter's goal? — the rat-fails-KillEnemy check at the type level).

**(d) Goal arbitration separated from planning.** F.E.A.R.: priority picks the goal, the planner serves it. Alchemy: one prose charter does both — the `phase.get` ternary in issues.ts is arbitration, the prose body of each branch is the how. The mechanism is right (arbitration is deterministic code in the turn, exactly where GOAP put it) but it is structurally invisible: the kernel cannot know which "goal" is active, cannot log it, cannot budget it, cannot settle on its satisfaction. Two phases and one ternary is fine. Ten phases with entry/exit conditions and per-phase tool grants is NOLF2's embedded FSM reborn in template literals — the precise disease Orkin built GOAP to cure. The charter author is back to manually specifying every transition.

**(e) HTN methods ≈ Skills — nearly.** A SHOP2 method is *(task, precondition, subtasks)*: encoded expertise for decomposing one named task. An Alchemy Skill is *(name, prose teaching a way of working, tools)*: encoded expertise, dormant until activated. The correspondence is real — a Skill is an HTN method whose "subtasks" are prose (interpreted by the model) instead of a symbolic network (interpreted by a decomposer). What a Skill does not declare is **the task it decomposes** and **a precondition for applicability**. SHOP2 would call an Alchemy Skill a method with no head. The `spawn` intrinsic completes the picture: a spawner writing `instructions` + `task` and handing pre-activated skills to a leaf worker *is* HTN decomposition with the model as the nondeterministic method-chooser — bounded exactly the way HTN bounds it (workers can't spawn or dispatch; decomposition terminates at primitives).

**(f) Utility for contention, not for choice.** Within a run, action selection belongs to the model — scoring candidate tool calls with response curves would be pointless duplication of what sampling does. But *across* runs, nothing in the model helps: when hundreds of parked runs are wakeable and the model budget is finite, "which run samples next" is a pure arbitration problem with no plan structure — precisely the shape IAUS handles well (many candidates × few considerations, O(n), continuous, never stuck, personality by curve). Staleness, user-facing urgency, cost-so-far, expected-value-of-progress are considerations; multiply and rank. This also answers cost discipline: GOAP's cost-per-action has no Alchemy analog anywhere, and prose ("prefer the cheap tool") is not a cost model.

**(g) Replanning: situation message vs. explicit invalidation.** GOAP replans when a sensor invalidates the plan — *detection is deterministic*, response is a fresh search. Alchemy delivers a `<situation>` message and lets the model reconcile. The situation message is the right default: model-level replanning is native, and Suchman says the plan was only ever a resource anyway. It fails in one specific regime: **long transcripts anchor**. A model forty tool-calls into a dead approach does not reliably abandon it because one user-role message said the world changed; the dead plan's tokens outweigh the situation's. GOAP's structure suggests the missing escalation ladder: deterministic monitors detect invalidation (cheap, reliable), and the response escalates — inject situation (today's mechanism) → compact/reset the transcript around the frozen head plus a summary (a new "plan formulation" from clean state) → settle as failed. Detection deterministic, reconciliation model-side, *demolition* kernel-side.

**(h) The Pengi endorsement.** Alchemy's runs are keyed by world identity (`owner/repo#7` = *the-issue-I-am-triaging*); locals are per-run deictic state; the stance is re-derived from the current situation every tick; mention-is-presence arbitrates capabilities reactively; perpetual processes park and wake on world events with no represented plan. That is deictic representation, routines, and action arbitration — the Agre/Chapman architecture with an LLM where the combinational network was. This is why the model feels right for perpetual processes and is genuinely novel among agent frameworks: most competitors are capital-P Planners (explicit plan artifacts, DAG executors) and inherit the brittleness Pengi diagnosed. The charter/stance side needs no planning transplant. The gaps are all on the *bounded-run* side: bounded goal-seeking work wants success/failure/giving-up semantics, and reactivity alone never terminates.

## 4. Comparison with the charter/stance/kernel model

Where each side wins:

**Prose-stance-reactivity beats explicit planning** when: the world moves mid-run (perpetual processes; GOAP has no story for a run with no goal state, and an HTN network that never terminates is a bug, not a design); the action space is open-textured (no symbolic effect model of "comment asking the author for what's missing" is truthful — Chapman's combinatorial-explosion argument, and Pengi's "most real situations cannot be completely represented," apply with full force to GitHub-shaped worlds); judgment is the work (the Issues charter's "READY when acceptance criteria are precise enough" is not a predicate over any blackboard anyone can write down).

**Explicit planning beats prose-stance-reactivity** when: completion must be checked, not vibed (quiescence-as-success means "the model stopped talking," which is neither success nor failure); resources must be bounded (no cost model, no budget, no giving-up — a GOAP goal that can't be satisfied fails fast and falls back to the next goal; an Alchemy run that can't succeed burns budget until the world settles it); behavior must be audited or tested (a Goal Set + Action Set is statically analyzable — the rat provably cannot kill; a prose charter's competence is only empirically testable); many runs contend (nothing arbitrates; GOAP at least had goal priorities, IAUS has a full answer).

**What breaks at scale**, concretely:

1. **Charter complexity.** Phase locals + ternaries are embedded FSMs. At 2 phases (issues.ts) they're elegant; at 10 they're NOLF2. The failure mode is quadratic: every new concern (a "turn on the lights" requirement) must be threaded through every phase branch by hand.
2. **Hierarchical decomposition** exists only through `dispatch`/`spawn` prose. Fine — that's HTN with the model choosing methods — but methods (Skills) being headless means neither the model's toolkit description nor any static check knows *which task* a skill decomposes, so method selection is uninformed and untestable.
3. **Durability**: a GOAP agent's plan and working memory are small serializable state; an Alchemy run's essential state is a transcript plus locals. The stance model actually helps here (the head is frozen, the stance is re-derivable from locals + world), but only if locals are the *complete* non-transcript state — worth making a stated invariant.
4. **Cost**: nothing meters anything. Every tick re-renders, every wake re-samples; a chatty steer-source can make a parked run arbitrarily expensive. No admission control, no per-run or per-goal budget, no cost-aware arbitration.
5. **Testability**: the deterministic skeleton (turn arbitration, tool guards, locals) is testable today; everything load-bearing about *whether the run achieves its purpose* is prose → model → hope. Reified goals give tests a machine-checkable target ("after these events, `satisfied` returns true").

## 5. Steal / adapt / reject

### STEAL: reified goals with deterministic satisfaction (`AI.goal`)

The highest-value item in the whole family. A goal is a term: prose (what the model reads) plus a deterministic satisfaction check (what the kernel trusts) plus optional abandonment semantics. The kernel evaluates `satisfied` at every quiescence (and optionally every tick); satisfaction settles the run from *inside* — a principled internal `settle` where today only the world may end a run. Exhausted budget fails the run with the existing `Refused` vocabulary.

```ts
const fixed = AI.goal("issue-fixed")`
The issue is closed by a merged pull request that cites it.`({
  // deterministic, kernel-checked at quiescence — observation, not memory
  satisfied: Effect.gen(function* () {
    const gh = yield* GitHub.GetIssue(testAlchemy);
    const issue = yield* gh(yield* AI.runKey);
    return issue.state === "closed" && issue.closedByMergedPr;
  }),
  // giving-up semantics: budget + typed surrender
  budget: { samplings: 40, tokens: 2_000_000 },
  onExhausted: Effect.fail(new AI.Refused({ reason: "budget" })),
});

// in a charter turn: mention renders prose AND registers the monitor
return yield* AI.prose`
Your purpose: ${fixed}. ${Coding} is your craft; ...`;
```

Perpetual processes are untouched: a charter that mentions no goal keeps today's exact semantics (park at quiescence, world settles). Goals are opt-in bounded-run machinery, not exit conditions smuggled into charters.

### STEAL: goal arbitration as a structured combinator (`AI.goals`)

Not a planner — structured sugar over the ternary, in F.E.A.R.'s shape: relevance picks the active goal deterministically; each goal carries its own stance. The kernel gains visibility (which goal is active is a fact, loggable, budgetable, testable), and charter authors stop hand-weaving transitions through every branch:

```ts
return yield* AI.goals(
  { goal: triage,   when: Effect.map(phase.get, (p) => p === "triaging"),
    stance: AI.prose`Every ${GitHub.IssueOpened} is checked ...` },
  { goal: unparked, when: Effect.map(phase.get, (p) => p === "awaiting-author"),
    stance: AI.prose`This issue is parked on its author ...` },
);
```

This directly attacks the state-machines-in-prose-ternaries scaling problem: shared clauses stay in the outer prose; per-goal clauses stop being threaded through unrelated branches; adding a goal is additive, which was Orkin's Benefit #2.

### ADAPT: Skills declare the task they decompose (HTN method heads)

Keep the model as method-chooser (full HTN — symbolic subtask networks with a decomposer — would recreate the rigid workflow engines the charter model escapes). Give the method a head so selection is informed and coverage is checkable:

```ts
export class Coding extends AI.Skill<Coding>()("Coding", {
  task: "implement a code change in a checkout and verify it",  // the method head
})`${Grep} before ${ReadFile}; ...` {}
```

Two skills declaring the same `task` are alternative methods — the model picks (SHOP2's nondeterministic choice), and the kernel's `skill`/`spawn` tool descriptions can say what each skill is *for*, not just that it exists. A static check falls out: a charter whose goal needs task T warns when no rendered branch mentions a skill/tool covering T — the rat that cannot kill, caught at compile time via the same R-channel machinery that already does capability-by-omission.

### ADAPT: utility scoring for run scheduling (kernel Layer, not charter feature)

An IAUS-shaped `Scheduler` service consulted at admission and wake, when runs contend for model budget. Considerations normalized to [0,1] through response curves, multiplied; the kernel samples the top-scoring wakeable run. Not exposed to charters; personality-by-curve belongs to the deployment, and a degenerate `Scheduler` (FIFO, score ≡ 1) is today's behavior:

```ts
export class Scheduler extends Context.Service<Scheduler, {
  readonly score: (run: RunSnapshot) => Effect.Effect<number>; // ∏ considerations
}>()("alchemy/AI/Scheduler") {}
// considerations: staleness ↑, userFacing ↑, costSoFar ↓ (logistic), goalProgress ↑
```

Reject utility for *within-run* action selection — that duplicates sampling.

### ADAPT: plan monitoring as an escalation ladder, not silent replan

Keep situation messages as the default reconciliation channel (they are Suchman-correct). Add deterministic invalidation monitors — a goal's `invalidWhen`, or a tool's declared postcondition failing — whose response escalates: (1) inject situation, today's mechanism; (2) **reset**: compact the transcript to frozen head + kernel-written summary of facts learned (a fresh plan formulation from clean state — the answer to transcript anchoring); (3) settle as failed/`Refused`. Detection is deterministic and cheap; the model reconciles when reconciliation is judgment; the kernel demolishes when the transcript itself is the obstacle.

### ADAPT (lightly): declared effects on tools — metadata, never search substrate

`AI.Tool("merge_pull_request", { effects: [PullRequestMerged] })` — consumed by monitors (did the declared effect obtain? if not, inject), by docs, and by the coverage check above. Reject any attempt to make declared effects the truth the system reasons over: prose-world actions have effects no symbolic model captures honestly, and pretending otherwise is how classical planning earned the Pengi critique.

### REJECT

- **A\*/backward-search plan synthesis over declared effects.** The LLM is the planner; a symbolic mirror-world accurate enough to search is unwritable for GitHub-shaped domains (Chapman 1985's explosion, Agre & Chapman 1987's representability argument) and would be a fiction the real world diverges from immediately.
- **Plan-as-artifact executed by a dumb executive** (the LangGraph/DAG shape). The stance model's bet — re-derive the stance from the situation every tick, let the model improvise against it — is the Pengi/Suchman position, and it is the *right* side of that thirty-year argument for open worlds. Freezing the model's chain-of-thought into an executable plan object re-imports every brittleness GOAP's own replanning existed to paper over.
- **Full HTN**: declared subtask networks with kernel-driven decomposition. The `spawn`/`dispatch` prose boundary already is decomposition, with the model as chooser; formalizing the network kills the judgment that makes it work.
- **Utility scoring inside a run**, per above.

## 6. Open questions

1. **Who checks satisfaction?** Deterministic Effects are trustworthy but can't judge "acceptance criteria are precise enough." Is there a typed two-tier check — deterministic `satisfied` plus an optional model-as-judge `assess` (a spawned leaf worker with a rubric), with the type system recording which tier settled the run?
2. **Do goals leak exit conditions into perpetual processes?** The Issues process should never end, but *per-phase* goals ("this issue reaches READY") would be useful waypoints. Does a satisfied goal settle the run, or can it merely advance a local and re-arbitrate — goals as milestones, not endings?
3. **Cost attribution across decomposition.** A spawner's budget should presumably charge its workers' sampling; does a `dispatch`ed delegate's cost bill the dispatcher, the delegate's own process, or both ledgers? GOAP's flat cost-per-action has no answer for hierarchies; SHOP2 never metered anything.
4. **Eventual consistency in satisfaction predicates.** `satisfied` observes the world (GitHub reads lag writes). Retry with a bounded schedule inside the check, or a kernel-level "satisfied must hold twice, N seconds apart" debounce?
5. **Mid-run goal injection.** `steer` delivers input; should it be able to deliver a *goal* (the world raising the stakes on a live run), and if so, is the arbitration combinator re-evaluated over a run-local goal set rather than a charter-static one?
6. **How far can the static coverage check go?** Capability-by-omission is already type-level; goal-task-skill coverage seems reachable with method heads and effect metadata. Is there a useful gradient short of the dishonest extreme (full symbolic reachability analysis, which §5-REJECT rules out)?
