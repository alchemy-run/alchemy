# Statecharts, SCXML, and XState — research for alchemy's charter/stance model

One of nine parallel research reports informing the design of alchemy's AI kernel. Topic: the statechart tradition (Harel 1987 → SCXML → XState v5 → @statelyai/agent) and what it says about agentic loops that work toward a goal and run in perpetuity.

## 1. The paradigm (precise semantics)

A finite state machine is a closed set of **states**, a closed **event alphabet**, and a **transition function** `(state, event) → state`. Its virtue is exhaustiveness: every (state, event) pair is either handled or provably rejected. Its vice is **state explosion**: `n` independent boolean aspects need `2^n` flat states, and every shared behavior must be copied onto every state that exhibits it.

Harel's 1987 contribution is exactly three mechanisms that fix this, plus a slogan: *statecharts = state-diagrams + depth + orthogonality + broadcast-communication*.

**Depth (XOR hierarchy).** States nest. Being in a child state entails being in its parent; a transition drawn from the parent applies to all children — parent handlers are **defaults**, and event lookup starts at the deepest active atomic state and walks up (SCXML makes this walk normative). A child state **refines** its parent: it inherits the parent's transitions and adds or overrides its own. Crucially, states are **modes of behavior**, not data: the question "which state am I in" is the question "which rules currently apply."

**Orthogonality (AND decomposition).** A state may split into concurrent **regions**; being in the state means being in one substate of *each* region simultaneously. Harel shows the flat equivalent of a two-region chart is the cross product of the regions — orthogonality is precisely the antidote to exponential blow-up. Regions are independent by default and coordinate only through shared events (broadcast: an event raised anywhere is seen by all regions).

**History.** A compound state may carry a history pseudostate: on re-entry, instead of the default initial child, the machine restores the child that was active when the state was last exited. **Shallow** history remembers one level; **deep** history remembers the whole nested configuration. History exists because in a statechart, *control is location* — leave a region and the location is lost unless explicitly remembered.

**Entry/exit actions and the run-to-completion algorithm.** SCXML (the W3C standardization, 2015) pins down execution order: to take a set of transitions, exit all states in the exit set (running their `onexit` handlers, innermost first), execute transition content, enter the entry set (running `onentry`, outermost first). A **microstep** is the execution of one "optimal enabled transition set"; a **macrostep** is a maximal series of microsteps — eventless ("NULL"-enabled) transitions and internally-raised events are drained until the internal queue is empty and nothing more fires. Only *then* does the processor touch the **external event queue**, and only at macrostep boundaries do `<invoke>` handlers for newly-entered states start. External input is thus never interleaved with an in-progress reaction — run-to-completion is the whole point.

**Guards and closed alphabets.** A transition fires only if its event matches and its `cond` guard evaluates true. An event no active state handles is (in SCXML) simply discarded; in XState v5 it is a type error to *send* an event the machine doesn't declare, and `snapshot.can(event)` answers "is this transition currently legal" mechanically.

**XState v5's actor model.** Everything running is an **actor** with encapsulated state, communicating by asynchronous events. A machine is just one kind of actor logic alongside promise, callback, observable, and plain transition-function logic. Actors are **invoked** (started on state entry, *stopped on state exit* — lifecycle bound to the state) or **spawned** (started in a transition, stopped explicitly or with the parent). Delayed transitions (`after`) are timers cancelled on state exit; eventless (`always`) transitions fire on configuration change. Every actor exposes `getPersistedSnapshot()`: state value + context as plain JSON, restorable in another process — the durability story is a first-class design axis.

## 2. Primary sources

What I actually read, and to what depth:

- **Harel, "Statecharts: A Visual Formalism for Complex Systems", Sci. Comp. Prog. 8(3), 1987** — [PDF](https://dubroy.com/refs/Statecharts_a_visual_formalism_for_complex_systems.pdf). Read the sections on XOR decomposition/defaults, §3 AND decomposition (incl. the cross-product blow-up figure discussion), and enter-by-history.
- **SCXML W3C Recommendation** — [w3.org/TR/scxml](https://www.w3.org/TR/scxml/). Read §3.13 (the algorithm): microstep/macrostep definitions, exit/entry order, internal-before-external queue discipline, invoke-at-macrostep-boundary. Cross-checked against the [implementation report](https://www.w3.org/Voice/2013/scxml-irp/) test assertions and an [ICTAC 2023 formalization](https://eprints.soton.ac.uk/483120/1/ICTAC2023_SCXML.pdf) of run-to-completion.
- **statecharts.dev, "Welcome to the world of statecharts"** — [statecharts.dev](https://statecharts.dev/). Read in full (benefits/objections framing, executable statecharts).
- **XState v5 docs** — [machines](https://stately.ai/docs/machines), [actors](https://stately.ai/docs/actors), [parallel states](https://stately.ai/docs/parallel-states). Read the actor lifecycle (invoke vs spawn), `getNextTransitions`/`snapshot.can` introspection, parallel-state guidance ("avoid transitions between regions", `onDone` when all regions final).
- **@statelyai/agent 2.0 (alpha)** — [overview](https://stately.ai/docs/packages/agent), [decisions](https://stately.ai/docs/packages/agent/decisions), [migrating from a loop](https://stately.ai/docs/packages/agent/from-a-loop), [GitHub README](https://github.com/statelyai/agent). Read the overview and decisions pages in full; from-a-loop and README in substantial excerpt. Also read a synopsis of Khourshid's ["Making State Management Intelligent"](https://gitnation.com/contents/making-state-management-intelligent) talk and the v1 docs' feature surface (observations/feedback/plans/`fromDecision`) for the v1→v2 delta.

## 3. Mapping to LLM agentic loops

The load-bearing observation first: **alchemy's kernel is already a statechart interpreter in disguise, at the operational level.** The homomorphism is close to exact:

| Statechart concept | Alchemy today |
|---|---|
| State (mode of behavior) | `AI.local` phase value; the turn's branch over it |
| Moore output of a state | The stance — prose + tool grants for this mode |
| Per-state event alphabet | The per-tick toolkit (mention = presence: `await_author` exists only in the `triaging` branch) |
| Model-initiated transition | Inline tool whose handler is `phase.set(...)` |
| Externally-triggered transition | `steer` / `settle` from the world |
| Macrostep / run-to-completion | The sampling loop: steers queue while a step is in flight, delivered only at the next boundary; quiescence = macrostep complete |
| External event queue | The run's inbox; park = SCXML's "wait till events appear" |
| Orthogonal regions | Multiple `AI.local`s in one charter |
| Snapshot | run key + locals map + transcript |

The kernel's "steering is delivered at the SAMPLING BOUNDARY … never aborting in-flight work" *is* SCXML's rule that external events are consumed only between macrosteps. This was converged on independently, which is evidence it's the right invariant.

Now the load-bearing questions:

**Reify or keep emergent?** The `phase` ternary is fine at 2 states. At 5 it's a `Match` over a union inside a template literal — readable but unverifiable: nothing stops a branch from mentioning a transition tool it shouldn't hold, nothing checks every state has an exit path, nothing renders the topology for review. At 15 it's the flat-FSM failure mode Harel wrote the paper about, transposed into prose: shared clauses copied into every branch, transitions scattered through closures, reachability unknowable. The statechart lesson is not "you need a chart interpreter" — the kernel already is one — it's that **the transition structure should be declared data, not emergent writes**, because everything valuable (typo-checking the target state, exhaustiveness over states, entry/exit hooks, visualization, audit logs, persistence schema) falls out of the declaration. The cost of reifying is rigidity where judgment lives; §4 addresses where the boundary goes.

**Hierarchy.** Alchemy already has the *output* half of hierarchy: the issues charter's outer prose (identity, closure rules) is the parent state's invariant behavior, and the branch is the child refinement; tools mentioned outside the branch are available in every phase — exactly "parent handlers as defaults." Nested fragments nesting is genuinely enough for prose hierarchy. What's missing is the *transition* half: a parent-level handler ("in any triage substate, a `IssueClosed` settles") — but in alchemy that lives in the implementation Layer's event routing, which is arguably a better home: the world's Layer is the parent state. Verdict: nested prose + nested machines (a state whose prose allocates a child machine) covers hierarchy without new semantics.

**Orthogonal regions.** Multiple locals are already AND decomposition, and better than a single `phase` local of tuple type: `author-responsiveness × CI-status × review-state` as three locals composes additively in prose (each contributes a clause) with no cross-product anywhere. This is a place alchemy's design is *already correct* and a flat reified enum would be a regression. The one thing declared regions add is the join: XState's parallel `onDone` fires when all regions reach final states. In alchemy that's a derived read in the turn (`if allDone → closing stance`) — no machinery needed, but a `phase.isFinal`-style predicate on a machine combinator makes it legible.

**Guards and the closed alphabet.** Two different things hide under "guard":

- *Mechanical guards* — facts code can check: amount ≤ $100, CI green, an approved review exists. @statelyai/agent's central move is that the model chooses one currently-legal event and `snapshot.can(event)` vetoes it mechanically, with a typed retry loop (`unknown-event` / `invalid-payload` / `rejected-by-guard`, prior failures fed back). Alchemy has the pieces: tool parameters are schema-validated, and `failureMode: "return"` makes `Effect.fail(text)` a model-visible rejection the agent reacts to — that *is* the rejected-by-guard feedback loop. The `MergePullRequest` tool that "refuses without an approved review" is already a guard on a transition, in exactly the right place: the tool handler.
- *Judgment guards* — "is the issue READY" is not a predicate; making it one either forces a dedicated boolean LLM call (a stilted extra sampling) or degrades into a rubber stamp. Alchemy's prose stance is the correct vehicle: the criterion is stated, the model judges, the *transition tool* is the commitment point.

On the event alphabet: `Accepts` already narrows `In` from spliced events — a declared alphabet at the type level. XState's *reject-unhandled-events* discipline should not be copied: the LLM is the thing flat charts never had, a **universal default handler**. An unmodeled steer ("the author got hostile") is handled sensibly by the model from the current stance; a statechart would drop it on the floor. Queue everything, declare what you can.

**Entry/exit actions.** "Post a comment when entering awaiting-author" is currently a prose instruction ("${Comment} FIRST … then call this") — the model *usually* complies. The statechart answer is deterministic `onentry`. The right split: **content is judgment, occurrence is mechanism.** What the comment says must stay with the model; that a comment happened before parking can be a guard on `await_author`'s handler (fail model-visibly if no comment was posted this run), or an entry effect can do deterministic bookkeeping (labels, timers, audit records) the model shouldn't be trusted to remember. Where the action is *itself* judgment-free (add the `awaiting-author` label), the transition handler should just do it — asking the model to do deterministic work is spending nondeterminism on nothing.

**History states.** Statecharts need history pseudostates because their control is *location* — exit a compound state and the configuration is gone. Alchemy's control is *data*: locals persist across park/wake and across phase changes, so deep history is free. This is one of the strongest arguments for the current design over machine-hosted control flow. The genuinely useful mapping is to the known supersession edge: when a run's stance returns to the head (all situation blocks gone), the kernel currently delivers nothing, so the last situation — which "supersedes … instructions above" — is never revoked. SCXML's discipline (re-entry is announced; entry actions run) says the fix is: **returning to a previously-rendered configuration is still a transition and must be delivered** — an explicit "situation: back to the original stance" message when the diff goes from nonempty to empty. One-line kernel fix, semantics borrowed from history states.

**Invoked actors.** XState's invoke — started on entry, *cancelled on exit* — has no alchemy analog: a dispatch to `${Engineer}` awaited inside a tool call survives any phase change, and a fire-and-forget delegate leaks past the phase that spawned it. Effect has the exact right primitive: give a reified phase a `Scope` per state occupancy; `phase.fork(effect)` forks into it; exiting the state closes the scope and interrupts. This is the one statechart feature that requires new kernel machinery and clearly pays for it (perpetual processes will accumulate orphaned delegate work otherwise).

**Durability.** XState's persistence model — every settle point yields a plain JSON snapshot (state value + context), restorable elsewhere — is the proven shape for the Durable-Object kernel, and @statelyai/agent confirms the decomposition: *snapshot* and *message history* persisted separately. Alchemy's run state is `Map<unknown, unknown>` keyed by construction-site `Symbol`s: not serializable, no schema, and key identity breaks across deploys. For the DO kernel, "run state = statechart snapshot + transcript position" is right, which forces: **named, schema'd locals** (`AI.local("phase", S.Literals(...), "triaging")`), snapshot = `{ locals: Record<string, Json>, transcript: cursor }`, checkpointed at quiescence (the macrostep boundary — exactly where SCXML says invoke handlers start and XState says snapshots settle). Snapshot migration across charter versions is unsolved in XState too; naming + schemas at least make it *addressable*.

## 4. Comparison with alchemy's charter/stance/kernel model

**Who owns transitions?** This is the axis the two designs actually differ on. @statelyai/agent inverts alchemy: the machine is outside, the model is invoked *by* states (`agent.decide` = one forced-choice sampling: pick exactly one currently-legal event; illegal choices rejected pre-effect). Alchemy puts the model outside: the sampling is open-ended work, and transitions happen as side effects of tool calls *within* it. The statelyai form buys legality-by-construction, path enumeration, simulation without API keys, and visualization — and pays in naturalness and cost: every transition is its own model round-trip, the model can't interleave work with the decision, and the prose lives shredded across `input` builder functions (prompt-last, machine-first). Alchemy's form is prose-first and one sampling does work + judgment + transition — but the topology is invisible and nothing can be verified statically. For compliance-critical flows (refunds), machine-outside is right; for goal-seeking open work (write the fix), model-outside is right. Alchemy's *processes* sit between, and can have both: the working loop model-outside, with mechanical guards at commitment-point tools.

**What @statelyai/agent got right** (per its own docs): the mechanical-guard veto with typed, fed-back rejections; snapshot persistence at settle points; machines-as-data (lint/simulate/visualize without a model); `allowedEvents` typed against the schema so a typo is a compile error; the honest "if you never need those four, the loop was fine" framing in from-a-loop. **What it got wrong or abandoned:** v1 was an RL-flavored apparatus — observations, feedback, `getPlans`, graph-shortest-path planning over the state space — scrapped wholesale in the 2.0 rewrite (still alpha; storage adapters, OTel, dynamic parallelism all explicitly unshipped). The v1→v2 arc is itself a finding: the *learning* machinery didn't survive contact; what survived is the boring core — guards, snapshots, legality. Its remaining structural weakness for alchemy's purposes: charters degenerate into config trees, and judgment criteria ("guess on the final turn") end up as system-prompt strings inside invoke inputs — the opposite of prose-first.

**Where statechart rigor fights the model.** Guards must be decidable; agentic conditions mostly aren't. A chart that owns "READY" either lies (rubber-stamp guard) or bloats (a decision sampling per judgment). Closed alphabets drop exactly the inputs perpetual processes exist to absorb. Eventless-transition cascades and broadcast would fire invisible logic between samplings, wrecking transcript legibility. The correct division, consistent across every source read: **the chart owns what must never be violated; the model owns what cannot be specified.**

## 5. Steal / adapt / reject

**STEAL — a declared-phase combinator over `AI.local` + prose-per-state.** Keep prose-first; make the topology data. Sketch in alchemy's idiom:

```ts
const phase = yield* AI.machine("phase", {
  initial: "triaging",
  states: {
    triaging: {
      prose: ({ awaitAuthor }) => AI.prose`
Every ${GitHub.IssueOpened} is checked for prior art with ${SearchIssues}. …
An issue is READY when its acceptance criteria are precise enough that
someone who has read nothing else could start work. Until it is,
${Comment} asks for exactly what is missing and ${awaitAuthor} parks it.
A ready issue is handed to ${Engineer}.`,
      on: {
        awaitAuthor: AI.transition("await_author")`
Park this issue on its author. Ask your questions with ${Comment}
FIRST — then call this.`({
          to: "awaiting-author",
          guard: hasCommentedThisRun,          // Effect<true | string> — string = model-visible refusal
          onEnter: addLabel("awaiting-author"), // deterministic, exactly once
        }),
      },
    },
    "awaiting-author": {
      prose: ({ resumeTriage }) => AI.prose`
This issue is parked on its author. Judge their latest reply: when it
closes the gaps, ${resumeTriage} and proceed.`,
      on: {
        resumeTriage: AI.transition("resume_triage")`
The author's reply closed the gaps.`({ to: "triaging" }),
      },
    },
  },
});
// TURN:
return yield* AI.prose`
This process manages issues for ${testAlchemy} from open to close. …
${phase.stance}
A merged fix closes its issue with ${CloseIssue} …`;
```

What the combinator guarantees that the ternary can't: `to:` targets are typo-checked against the state union; every state's transition tools are mentioned only in that state's stance (per-state closed alphabet by construction, not by discipline); `onEnter`/`onExit` run exactly once per change, in Effect code; the state is a **named, schema'd, serializable** local (the DO-kernel snapshot unit); the topology is data — renderable as a diagram, lintable for unreachable states, auditable as a transition log. Judgment stays exactly where it is: in the prose, with the transition tool as the commitment point. `R`-channel typing is unchanged — the union of all states' splices, which is what alchemy already computes.

**STEAL — phase-scoped forks (invoked-actor lifecycle).** `phase.fork(effect)` forks into a per-occupancy `Scope`; exiting the state interrupts. This is the only item needing kernel support beyond the combinator, and perpetual processes need it.

**STEAL — the snapshot discipline.** Named locals + schemas; snapshot = `{ locals, transcript cursor }`; checkpoint at quiescence (the macrostep boundary). Persisting snapshot and transcript separately, per @statelyai/agent.

**ADAPT — history semantics for the supersession edge.** Treat "stance returned to head" as a real re-entry: deliver an explicit superseding situation. Do *not* add history pseudostates — state-as-data makes them free.

**ADAPT — guards as tool-handler refusals.** Standardize the pattern already latent in `MergePullRequest`: mechanical preconditions live in transition handlers; `Effect.fail(text)` is the typed, fed-back rejection (@statelyai/agent's retry loop, for free, inside the working sampling instead of a dedicated one).

**ADAPT — orthogonality stays as multiple locals/machines.** Two `AI.machine`s in one charter are AND regions. Provide `phase.is("x")` / final-state predicates so joins read declaratively in the turn. No region machinery.

**REJECT — full SCXML/XState execution semantics.** No eventless-transition cascades, no internal-event broadcast, no internal/external transition distinction: the sampling loop is the macrostep, and invisible inter-sampling logic destroys transcript legibility.

**REJECT — machine-first authoring and decision-per-transition.** The @statelyai/agent shape (states invoke the model; every transition a forced-choice sampling) inverts prose-first and roughly doubles sampling cost for chatty flows. Transitions-as-tools inside the working loop remain the primary mechanism; a forced-choice `decide` is worth adding *only* if a compliance point ever demands "the model may do nothing but choose."

**REJECT — closed input alphabets and the v1 learning apparatus.** Keep `steer` permissive (the model is the default handler flat charts never had). Observations/feedback/shortest-path planning: statelyai themselves walked it back.

Scaling answer to the design question: at 5 phases the combinator is nice; at 15 it is necessary — and it is a ~200-line library over existing primitives (`AI.local` + inline tools + prose), not a new kernel. The current model is right; its transition structure just needs to become data before charters grow.

## 6. Open questions

1. **Who besides transitions may set a machine's state?** The implementation Layer sees world events first — should it be able to force a phase (`IssueClosed` → `closed`) without a model tick, and does that bypass `onExit` scopes or run them?
2. **Two transitions in one sampling.** Tool handlers execute inside one `generateText` step; if the model calls two transition tools in one round, what is the conflict rule? (SCXML's "optimal transition set" has an answer; alchemy needs one — likely: second transition tool call in a tick fails model-visibly.)
3. **Should the kernel render the state value into the situation automatically** (`phase: awaiting-author`) for model orientation and audit, or is the per-state prose the only surface?
4. **Snapshot migration.** A redeployed charter with renamed states meets a persisted `{ phase: "awaiting-author" }` — schema-evolve, map, or settle the run? XState punts on this too; the DO kernel can't.
5. **Typed steer routing.** Is per-state narrowing of `Accepts` (state × event legality at the type level) worth the type machinery, or does runtime queue-everything + prose suffice?
6. **Transition log as org ledger.** Declared transitions make an audit trail (`who moved owner/repo#7 to awaiting-author, when, why`) essentially free — should the Ledger consume it?
