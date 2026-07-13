# Agent / Loop — the underlying algebra

> **Status note (July 2026).** The formal model below is still correct, but the design has since converged on an **actor/message reading** as the primary interpretation of the same algebra, and one elimination (the trigger-lift, `serve`/`run()`) has been demoted to vestigial. See the [v2 addendum](#v2-addendum) at the end of this file, and the canon: [designs/ai/business-processes.md](../business-processes.md). Where a section below is superseded, an inline note points to the addendum; the math is left standing.

A design-research report answering: **what IS the difference between `Agent` and `Loop`, mathematically? Is one a special case of the other? Is there one general abstraction both are instances of?**

Method: `designs/ai/alchemy-ai-design.md` read end to end (§0, §1, §2, §8, §9 closely); every file in `packages/alchemy/src/AI`; the reference org fixtures (`test/AI/fixtures/org`, `test/AI/Org.types.ts`, `test/AI/Loop.types.test.ts`); the harness reports (`pi.md`, `ai-sdk.md`, `codex.md`, `opencode.md`, `mastra.md`, `eve.md`); and Effect v4's `Channel` type (`node_modules/effect/dist/Channel.d.ts`). Every claim about existing code cites `file:line`; claims sourced from the design doc or the survey reports are marked as such.

---

## 0. Verdict up front

**There is one semantic object.** Call it the **interpreted process**:

```
Run<Out, Err, Req>          ≅ Channel<KernelEvent, Err, Out, Steer, never, never, Req>
Process<In, Out, Err, Req>  =  (item: In) → Run<Out, Err, Req>
```

— a Kleisli arrow into a channel monad that *emits events* (covariant), *accepts steering* (contravariant), *completes with a typed result* (covariant), and *demands capabilities* (`Req`). `dispatch`, `run()`, `steer`, `interrupt`, and `AI.observe` are the five canonical **eliminations** of this one object, and the ring-vs-run distinction is **derived** (the Effect view vs the trigger-lifted view of the same channel). *(v2: the actor reading of this object is now primary and `run()`/the trigger-lift is vestigial — see the [addendum](#v2-addendum).)*

- **Semantically, Agent ⊂ Loop**: an Agent term denotes a Process whose control parameters (trigger, halt, fold, budget) are kernel defaults instead of reified refs. The design doc already says this in its own vocabulary: the agent turn "is Kernel-internal and deliberately has **no halt term**; that exit is kernel policy" (design §8.2 ring table, ~line 946).
- **Operationally, Loop = serve(hylo(body))**: the loop runtime (§2.5) is an unfold-then-fold (hylomorphism) whose body arrow is built from agent turns, with `Fold` the algebra, `Halt`+`Check` the termination coalgebra, `Budget` the fuel grading — so "Loop = iterated Agent" is also true, *at the interpretation level*, not the term level.
- Both candidates in the question are therefore projections of the same object, and neither should be taken as a definition of the other.

**Recommendation** (Phase 1, interfaces only):

1. **Unify the services**: one `ProcessService<Out, In, Err>` shape that both terms produce; `LoopService` becomes an alias; `AgentService` becomes `ProcessService<Message, AgentIn, never>` with channels supplied by kernel defaults (typed, not ref-derived).
2. **Do NOT unify the term kinds.** `Agent` and `Loop` remain distinct `~alchemy/Kind`s with distinct constructors — the difference between them is real and load-bearing: *who supplies the control parameters* (kernel policy vs charter refs). Collapsing the terms would let prose override the execution ring's exit, which §8.2/§8.5 deliberately forbid.
3. **Kernel gets one `interpret(term)`** replacing the `agent`/`loop` method pair (which differ only in how the service's type parameters are computed — `src/AI/Kernel.ts:76-85`).
4. `send` is revealed to be the **admission half of `dispatch`** (fire-and-forget enqueue); the `session` parameter on `send` is a smell — session identity belongs **inside `In`** (world identity: the work item is the session key), matching the design's pending decision and OpenCode/Codex/Eve evidence.

---

## 1. The model

### 1.1 What the code has today (the two objects to be explained)

The `Agent` term interprets into:

```54:59:packages/alchemy/src/AI/Agent.ts
export interface AgentService {
  send(request: {
    input: any;
    session?: string;
  }): Effect.Effect<void, never, RuntimeContext>;
}
```

The `Loop` term interprets into:

```62:82:packages/alchemy/src/AI/Loop.ts
export interface LoopService<Out = void, In = unknown, Err = never> {
  /** Execute one run of the loop for a single work item. */
  dispatch(item: In): Effect.Effect<Out, Err>;
  /** Serve the ring: consume triggers and dispatch runs until interrupted. */
  run(): Effect.Effect<never, Err>;
  // …steer(input): Effect<void>; interrupt(): Effect<void>
}
```

The Loop's channels are derived from refs — `Out` from the halt (`src/AI/Loop.ts:20-26`), `In` from the triggers (`Loop.ts:33-37`), `Err` from budget/bounded-exit (`Loop.ts:48-50`); `Req` from all refs via `Services<Refs>` (`src/AI/Services.ts:44-63`). The Agent's channels are *not derived*: `input: any`, `Out` erased to `void`, `Err` fixed at `never`, plus a hand-supplied `session` string. The Kernel has one method per kind (`src/AI/Kernel.ts:76-85`) and `AI.layer` branches on `isAgent` (`Kernel.ts:131-140`).

Two asymmetries worth naming now, because the model explains both:

- `AgentService.send` requires `RuntimeContext` (`Agent.ts:58`); `LoopService.dispatch` does not (`Loop.ts:64`). No principled reason for the difference exists in the code or design doc.
- `LoopService.steer/interrupt` exist (`Loop.ts:74, 81`); `AgentService` has no counterpart — yet pi's steering queues are an *agent-turn* feature (pi.md §2.1), so the asymmetry is accidental, not essential.

### 1.2 Four candidate abstractions, and why they are one

**(a) Kleisli arrow.** A Tool's runtime callable is `Input → Effect<Output, Err, RuntimeContext>` (`src/AI/Tool.ts:66-78`). A Loop's `dispatch` is `In → Effect<Out, Err>` (`Loop.ts:64`). Composition is Kleisli composition in the `Effect` monad: identity `pure`, associative `>=>`. This is exactly what makes loop nesting typed end to end — "the outer ring may dispatch typed runs of the inner ring" (design §1.2.1, line 104), and the fixture proves it: `fix.dispatch(issue): Effect<PullRequestRef, BudgetExceeded | Refused>` (`test/AI/fixtures/org/cloudflare/worker.ts:157-176`).

*What it misses:* the arrow view has no place for the event stream (Trace), steering, or perpetuity (`Effect<never>` is expressible but degenerate). It is a **projection**, not the object.

**(b) Mealy machine / transducer.** The design doc's normative step machine (§2.4):

```
step : (state: StepState, fb: Feedback) → readonly [StepState, Command[]]
```

is precisely a Mealy machine `S × I → S × O` with `I = Feedback`, `O = Command[]`. Mealy machines compose by wiring one machine's output alphabet to another's input alphabet; their laws are the coalgebra laws (determinism, no hidden state — which §2.4's purity checklist enforces operationally: no clocks, no id generation, `StepState` survives `structuredClone`).

*What it misses:* the Mealy machine is the **implementation** of one run, not its interface. It also has no typed *completion* — `Halt { result }` is just another command; the machine itself doesn't know `Out`.

**(c) Free monad over the Command functor.** §2.4's `Command` union (`CallModel | CallTool | Emit | Ask | ForkLoop | Checkpoint | Halt`) generates a functor `F`; one run is a term of `Free F` (an interaction tree: request a command, receive a `Feedback`, continue). The Mealy machine (b) is the state-machine *presentation* of this tree (its coalgebraic unfolding); interpreting `F` into a harness gives the run's semantics. `Halt { result }` is the `Pure` constructor — which is where `Out` re-enters.

*What it misses:* nothing semantically, but it is a syntax, and it has no native Effect encoding — which is exactly what (d) supplies.

**(d) Effect Channel.** Effect v4's channel type (`node_modules/effect/dist/Channel.d.ts:117`):

```ts
interface Channel<out OutElem, out OutErr = never, out OutDone = void,
                  in InElem = unknown, in InErr = unknown, in InDone = unknown,
                  out Env = never>
```

A **run** of either term maps onto it exactly:

| Channel parameter | Run meaning | Existing surface |
|---|---|---|
| `OutElem = KernelEvent` | the emitted Trace/live events | `Kernel.events` / `Kernel.trace` (`Kernel.ts:87-92`) |
| `OutErr = Err` | `BudgetExceeded \| Refused` (`Errors.ts:17-49`) | `LoopErr` (`Loop.ts:48-50`) |
| `OutDone = Out` | the halted run's resolution | `LoopOut` (`Loop.ts:20-26`) |
| `InElem = Steer` | mid-run input at the iteration boundary | `LoopService.steer` (`Loop.ts:74`) |
| `Env = Req` | capabilities resolved from ambient context | `Services<Refs>` (`Services.ts:59-63`), consumed at `Kernel.ts:76-85` |

Streams and Sinks are the one-sided degenerations of Channel ("both streams and sinks are built on channels", `Channel.d.ts:74-78`), and `Channel` is a monad in `OutDone` (`flatMap` sequences on the done value), which is what makes (a) a projection of (d).

**The equivalence.** (b) unfolded against a command interpreter *is* (c); (c) encoded in Effect *is* (d); the `OutDone` projection of (d) *is* (a). One object, four presentations, each at the right layer:

- (b) Mealy coalgebra — the pure, replayable **implementation** (kernel-internal, §2.4).
- (c) Free/ITree — the **specification** of one run's syntax (useful for conformance/replay reasoning).
- (d) Channel — the **denotation** (what a run *is*, Effect-natively).
- (a) Kleisli arrow — the **caller's interface** (`dispatch`).

### 1.3 The one abstraction, stated precisely

Fix `E = KernelEvent`. Define:

```
Run<Out, Err, Req>          := Channel<E, Err, Out, Steer, never, never, Req>
Process<In, Out, Err, Req>  := In → Run<Out, Err, Req>
Triggers<In>                := Stream<In>            -- with merge as the monoid
```

`Run<_, Err, Req>` is a monad in `Out` (Channel's `flatMap` on `OutDone`), so `Process` arrows form the Kleisli category of that monad: `(f >=> g)(a) = f(a).flatMap(g)` — **events concatenate, the done value threads**. This category is where loop nesting lives.

**The five eliminations** (this is the complete service surface, derived rather than invented):

1. `effect : Run<Out, Err> → Effect<Out, Err, Req>` — drain the events, keep the done value. `dispatch = effect ∘ process`.
2. `stream : Run<Out, Err> → Stream<E, Err, Req>` — keep the events, erase the done value. This is the **Trace view**, and `AI.observe` (`src/AI/Observe.ts:26-47`) is precisely access to this projection *without* `Env` — see the variance theorem below.
3. `serve : Triggers<In> × Process<In, Out, Err> → Run<never, Err>` — the **trigger-lift**: `serve(t, p) = t.concatMap(p)` (with the charter's `Concurrency` as the merge policy). `OutDone = never` because the trigger stream is unbounded. `run() = effect(serve(triggers, p)) : Effect<never, Err>` (`Loop.ts:66`). *(v2: DEMOTED — see the [addendum](#v2-addendum). `AI.on` is now a pure input declaration with no auto-delivery; delivery is always outside code, so `serve`/`run()` is vestigial and the mailbox drain is kernel-internal.)*
4. `steer` — a write to the run's `InElem`, delivered at the iteration boundary (design §9.3: "steering = mid-run input delivered at the iteration boundary… promotion resets the step allowance"; pi.md §2.1 documents the same two delivery points empirically).
5. `interrupt` — not a channel operation at all: it is **Scope authority** over the run's fiber, entering operationally as a control admission through the same inbox (design §3.1 plane 1; fixture `test/AI/fixtures/org/cloudflare/kernel.ts:150-158` already routes it that way).

**The loop runtime is a hylomorphism in this model.** §2.5's runtime is:

```
body   : (Carried, In) → Run<IterationOutcome, BodyErr>       -- agent turns, inner-loop forks
check  : (Trace, HaltCondition) → Verdict                      -- goal-met | off-goal | waiting | check-failed
fold   : (Carried, TraceSegment) → Carried                     -- the algebra; THE carried state
halt   : selects Out and the termination predicate
budget : a grading — usage: Command → M (usage monoid), bound b ∈ M

dispatch = effect ∘ hylo(body, check, fold, halt, budget) : In → Effect<Out, Err>
```

The unfold produces iterations from the seed `(fold₀(in), in)`; `check` grades each candidate exit; `fold` compresses each iteration's trace into the next seed; `budget` bounds the unfold with fuel (per-command, transactional — §2.4). `Refused` is the coalgebra's ratified-give-up branch (`Errors.ts:42-49`); `BudgetExceeded` is fuel exhaustion (`Errors.ts:17-28`).

**And the agent turn is the same hylo at kernel defaults.** The kernel's default control parameters for an Agent term are:

```
trigger = the send/dispatch inbox        (each message is a work item)
halt    = "model returned no tool calls" (kernel policy — §2.4: "Termination is policy")
fold    = append to the carried transcript
check   = none (default judge policy)
budget  = none
```

This is not an analogy — it is the §8.2 ring table read as math: the execution loop is ring 2 of the same taxonomy, "each ring is a (verbs, exit, timescale) triple", and the agent's exit is simply *not reified as a term* because the design chose to keep ring-2 policy kernel-internal (design §8.2, ring mapping ~line 946).

### 1.4 The laws, and which ones our invariants need

| Law | Statement | Which invariant it carries |
|---|---|---|
| **Kleisli category** | `dispatch` arrows compose associatively with identity | Loop nesting: `Flywheel` dispatches typed `Fix` runs (`fixtures/org/loops.ts:69-75`); the worker route composes `fix.dispatch` with HTTP handling (`worker.ts:157-176`) |
| **Trigger-lift is a module action** | `serve(t₁ ⊕ t₂, p) = serve(t₁, p) ⊕ serve(t₂, p)`; `Done(serve(…)) = never` | Multiple triggers are legal and `In` is their union (`Loop.ts:33-37`; lint permits multiple triggers, `Lint.ts:33-44`); ring-vs-run is **derived**, not axiomatic |
| **Variance theorem** | In `Channel<out E, out Err, out Out, in Steer, …, out Env>`, everything that flows **up** is covariant; everything injected **down** is contravariant (`Channel.d.ts:117, 171-173`) | **§0.6 verbatim**: "authority flows down; information flows up." Upward = `Out` + events + typed errors (the three channels of §2.5); downward = steering, interruption (Scope), budgets. `AI.observe` grants only covariant surface, hence contributes no `Req` (`Services.ts:21-23`) — the constitutional constraint (`Org.types.ts:194-205`) is a *variance fact* |
| **Fold-as-checkpoint (hylo law)** | The fold is the *only* carried state: resuming from `(carried, seq)` and re-folding the trace suffix ≡ folding the whole trace (left-fold prefix property) | §0.8 "the fold is the unit of both memory and durability"; the Ring DO's two-plane state and the `fold()` snapshot with `promptHash` (`fixtures/org/cloudflare/kernel.ts:69-83`) |
| **Halt-derives-Out** | `OutDone` is literally the halt ref's phantom (`Halt.ts:32-40` → `LoopOut`, `Loop.ts:20-26`); no halt ⇒ `Out = never` ⇒ the Effect view is uninhabitable-return | §1.5 "the missing halt is a type"; the ai-sdk report's sharpest contrast: `result.output` **throws** when stopped via tool call — "our `Out`-from-halt makes that a compile error" (ai-sdk.md, Insight 3) |
| **Grading (fuel)** | `usage : Command → M` is a monoid homomorphism; the interpreter enforces `Σ usage ≤ b` per command, transactionally | §2.4 budget accounting; pi #4325 is the failure mode when grading is per-boundary instead of per-command (pi.md, Insight 8) |
| **Interpretation is Env-natural** | `interpret : Term → Process` may demand only tags recorded in the term's refs; nothing else can enter `Env` | Capability denial by absence-of-ref (design §0.2(d)); audited at `Org.types.ts:100-130, 199-205`. **Unification does not touch this** — `Req` is orthogonal to the `In/Out/Err` algebra |

---

## 2. The verdict

### 2.1 Is Agent ⊂ Loop? Is Loop = Fix(Agent)? Both — as projections, neither as a definition

**Agent ⊂ Loop is true denotationally.** Both terms denote a `Process`; the Agent's channels come from kernel defaults, the Loop's from refs. The subset relation is precise: the image of Agent-interpretation is contained in the image of Loop-interpretation (instantiate the hylo at the default parameters). But it is **false syntactically**, and should stay false: the execution ring's exit is deliberately not a term (design §8.2), because "naming a signal is not the same as wiring it in" cuts both ways — reifying the ring-2 exit as a halt ref would invite charters to override kernel policy for the one ring whose exit is model-behavior lore (Codex's continuation-audit prompts, codex.md Insight 5). The taxonomy's own warning applies: "the rings are **different types**… one recursive construct is the wrong shape" (design §8.3, Voss row; §8.5 explicitly rejects "a uniform recursive loop construct").

**Loop = Fix(AgentStep) is true operationally.** §2.5's runtime is an iterated body with `Fold` the algebra, `Halt`/`Check` the termination, `Budget` the fuel — a hylomorphism whose body arrow is built from agent turns. But it is **false as a term-level definition**: a charter's body is not one agent — Fix delegates to `Engineer` *and* `Judge` *and* `Scribe` (`fixtures/org/loops.ts:38-57`), Flywheel's body dispatches a nested *Loop* (`loops.ts:69-75`). The body is a kernel-interpreted arrow, of which a single agent invocation is the atomic case.

**The one abstraction is the interpreted process (§1.3), with the Channel as its denotation.** Against the alternatives:

- vs. *bare Kleisli arrow*: loses events, steering, perpetuity, and the ring/run derivation. `AgentService` as currently written is what this loss looks like (`Out` erased to `void`, no observation surface).
- vs. *Mealy/free-monad as THE abstraction*: right for the kernel's internals (§2.4 keeps it, normatively), wrong for the term/service layer — callers need eliminations (`dispatch`, `steer`), not coalgebra structure. Codex is the cautionary tale of exposing the machine: the SQ/EQ protocol is beautiful, but `Session` grew to 4,081 lines because everything else was welded to it (codex.md, Judgments).
- vs. *literal `Channel` as the public service type*: rejected. Channel is Effect's internal operator algebra ("most users shouldn't have to use channels directly", `Channel.d.ts:74-78`); seven type parameters with variance juggling would leak into every org file. The Channel is the right **semantic model** — and `AI.Kernel.memory` can implement runs as channels internally — but the service surface should stay the five eliminations with the verbs users already have.

### 2.2 Every existing term, expressed in the model

| Term | In the model | Code |
|---|---|---|
| `Tool` | degenerate Process: `In → Effect<Out, Err, RuntimeContext>` — no events, no steering, no interpretation (`OutElem = never`) | `Tool.ts:66-78` |
| `Agent` | `Process<AgentIn, Message, never>` at kernel-default control parameters; also **the atomic body arrow** the kernel knows how to interpret | `Agent.ts:29-59` |
| `Loop` | `Process<LoopIn, LoopOut, LoopErr>` = `serve ∘ hylo(body, …refs)`; the term is the only syntax for supplying the hylo's control parameters | `Loop.ts:129-155` |
| `Trigger` | the `Triggers<In>` object; `on`/`each`/`every` are constructors; multiple triggers = monoid merge *(v2: demoted to pure input declarations — no delivery semantics; see the [addendum](#v2-addendum))* | `Trigger.ts:40-65` |
| `Halt` | selects `OutDone` (+ the termination predicate's prose); `never` ⇒ `OutDone = never` | `Halt.ts:32-40` |
| `Check` | the grading of the termination coalgebra — an *agent arrow in verdict position*, `(Trace, halt) → Verdict` | `Check.ts:32-40` |
| `Fold` | the algebra `(Carried, TraceSeg) → Carried` — an *agent arrow in algebra position* | `Fold.ts:30-38` |
| `Budget` | the grading bound `b ∈ M` on the fuel monoid; `Concurrency` = the merge policy of `serve` | `Budget.ts:15-30, 51-59` |
| `Observe` | elimination (2) alone — the covariant `stream` projection, hence `Req`-free by variance | `Observe.ts:26-47`, `Services.ts:21-23` |
| `EventSource` | a `Triggers` constructor whose `Env` obligation (channel + wire) is the deploy-time half | `EventSource.ts:52-75` |

`Check` and `Fold` are the decisive evidence for the model: they hold `agent: A extends Agent` (`Check.ts:37`, `Fold.ts:35`) and use *only its arrow nature* — the kernel invokes them at the boundary as `(inputs) → output`, never as served processes. "Agent" in a positional role means exactly "**arrow the kernel interprets**", reusable in any position. The arrow is the unit of composition; *position* (body / judge / algebra) is orthogonal to *kind*.

### 2.3 Should AgentService and LoopService unify? Yes — the shape; no — the terms

`AgentService` (`Agent.ts:54-59`) is a `ProcessService` with every channel erased: `In = any`, `Out` erased to `void`, `Err = never`, no events surface, no steering, plus a hand-rolled `session` key. Each erasure is a concrete loss:

- `Out = void`: the caller cannot obtain the turn's result — yet the whole point of the positional roles is that agent invocations *return* things (the check's verdict, the fold's carried state). The kernel will need the typed arrow internally regardless.
- `Err = never`: correct as a default (tool errors are model-visible results, not failures — ai-sdk.md Insight 13; opencode's failure taxonomy), and should stay.
- `session?: string`: the smell the question suspected. See §2.4.
- The `RuntimeContext` coloring differs from `LoopService` (§1.1) for no reason.

The industry evidence that agent and loop unify **at the engine level** is unambiguous: the AI SDK's `ToolLoopAgent` "is a thin settings-holder that delegates to [the loop functions] — the agent class adds nothing to the loop itself" (ai-sdk.md §1); Mastra's "agent loop is implemented as a Mastra workflow" on its own engine (mastra.md §overview); Codex's `Session→Task(Turn)→sampling` nests three processes that all speak the same SQ-in/EQ-out interface (codex.md §1, §6 — the SQ/EQ contract *is* the channel interface: submissions = `InElem`, events = `OutElem`).

And the evidence that the **modal split must be in the types, not the runtime**, comes from Eve: its "task mode vs conversation mode" (bounded `Out` via `outputSchema` vs park-forever) is exactly our `Out = Schema["Type"]` vs `Out = never` — encoded modally at runtime, and "the conversation/task mode split leaks into a dozen code paths" (eve.md §3, weakness 7). Our `Out`-derivation is the compile-time version of the thing they had to bolt on.

### 2.4 What is `send`, really? Where does `session` belong?

**`send` is the admission half of `dispatch`.** Every surveyed durable system converged on a two-phase shape: *admit* (durable, idempotent, ordered) then *join/await* (optional, process-local): OpenCode's admit/promote inbox with idempotent receipts (opencode.md §2.5, Insight 4); Codex's totally-ordered SQ (codex.md Insight 11); the design's own §2.5 "ONE ordered, idempotent admission inbox"; and the fixture's `Ring.admit` keyed by `deliveryId` (`fixtures/org/cloudflare/kernel.ts:42-57`). In the model:

```
send(item)     = admit(item)                        : Effect<void>
dispatch(item) = admit(item) andThen await(done)    : Effect<Out, Err>
```

`dispatch`'s join handle is process-local — deliberately so: "a run is active is *derivable*… no durable run object is ever resurrected" (design §9.5, from OpenCode's "Session Drain has no durable identity", opencode.md Insight 6). `send` is not a different capability; it is `dispatch` without the join.

**`session` belongs inside `In`.** The design's pending decision — "the kernel stays thread-scoped and session identity derives from world identity (work item = session key)" — is exactly right, and the surveyed systems triangulate it: Codex reifies Session as a durable entity and pays with a god object (codex.md, Judgments); OpenCode refuses durable run identity and derives everything from the aggregate (the work item's world key); Eve splits resume-capability (`continuationToken`) from observe-capability (`sessionId`) — two *capabilities*, not one "session" parameter (eve.md Insight 4). In the unified model the run is identified by `(term, workItem)`; a Discord thread, a GitHub issue, a Fix work item — each *is* its session key. The `session?: string` argument on `send` is the caller hand-supplying the world identity that a Loop's `In` carries structurally. The fix is not to move `session` to `LoopService` — it is to delete the parameter and let `In` carry identity (an Agent serving an interactive surface receives `In` from the surface's EventSource payload, which contains the thread/conversation key; a bare interactive `dispatch` with no world identity gets a kernel-minted one-shot key).

### 2.5 Where do `steer` and `interrupt` live?

- **`steer` is `InElem`** — the contravariant input channel of a *run*, with delivery pinned to the iteration boundary and a step-allowance reset (design §9.3; pi's two queues with precise delivery points, pi.md §2.1; OpenCode's steer-vs-queue promotion, opencode.md §2.5). It belongs on the unified service. One unresolved addressing question the model surfaces: with `AI.concurrency(3)`, "the active run" is ambiguous — `steer` ultimately needs a run key (the work item's world identity again). Codex types this rejection vocabulary (`ExpectedTurnMismatch`, codex.md Insight 12). *(v2: RESOLVED as predicted — `steer(runKey, msg)` is P0 in the canon; in the actor reading it is simply "send a message to a running actor", see the [addendum](#v2-addendum).)*
- **`interrupt` is not a channel input at all — it is Scope authority**, the downward-flowing half of §0.6, realized operationally as a control admission through the same inbox (no second control plane — Eve failed to ship durable cancel five times through a separate hook layer, eve.md Insight 5; the fixture already routes `interrupt` through `admit`, `kernel.ts:150-158`). It stays on the service as a verb but is *not* part of the Kleisli/Channel algebra; it is part of the fiber model. This is why it never appears in `Err`.

### 2.6 Ring vs run: derived, as hoped

*(v2 note: this section's math stands, but the trigger-lift it analyzes is now vestigial — see the [addendum](#v2-addendum). The run/ring split survives as the actor/mailbox split.)*

`run()` = `effect(serve(triggers, process))`. The `never` in its type is a *theorem*, not a declaration: `serve`'s `OutDone` is `never` because the trigger stream is unbounded, independently of the run's `Out`. A perpetual charter (`AI.never`) additionally sets the *run's* `Out = never` — two different `never`s, and the code already keeps them distinct (`Loop.ts:53-61` doc comment: "Out is run-scoped… the ring never resolves"). In Channel terms: the ring is the Stream view of the lifted process; a run is the Effect view of one application. On the Cloudflare harness `run()` degenerates further — "a ring's charter compiles to routes… 'running' means 'reachable'" (design §3.1) — confirming that `run()` is a harness detail of elimination (3), not a primitive.

---

## 3. The refactor (Phase 1 — pure data, interfaces only)

### 3.1 One service shape

```ts
// src/AI/Process.ts (new)
import type * as Effect from "effect/Effect";

/**
 * The live handle every interpreted term produces — the five eliminations
 * of one object: a Process is `In → Run<Out, Err>` where a Run emits
 * KernelEvents, accepts steering, and completes with Out (or never).
 */
export interface ProcessService<Out = void, In = unknown, Err = never> {
  /** Admit one work item and await its run's resolution (admit + join). */
  dispatch(item: In): Effect.Effect<Out, Err>;
  /** Admit one work item, fire-and-forget (the admission half alone). */
  send(item: In): Effect.Effect<void>;
  /** Serve the ring: the trigger-lift. Done = never by construction.
   *  (v2: vestigial — no auto-delivery; see the addendum.) */
  run(): Effect.Effect<never, Err>;
  /** Mid-run input, promoted at the iteration boundary (InElem).
   *  (v2: addressed by run key — steer(runKey, msg); see the addendum.) */
  steer(input: unknown): Effect.Effect<void>;
  /** Scope authority: settle in-flight work as interrupted, fold, mark. */
  interrupt(): Effect.Effect<void>;
}
```

```ts
// src/AI/Loop.ts — LoopService becomes an alias; channels unchanged
export interface LoopService<Out = void, In = unknown, Err = never>
  extends ProcessService<Out, In, Err> {}
```

```ts
// src/AI/Agent.ts — Agent gains derived channels with conservative defaults
export interface AgentService<In = unknown, Out = unknown>
  extends ProcessService<Out, In, never> {}
// Err = never is a theorem here, not a default: tool errors are model-visible
// results; harness failures are KernelError at interpretation time.
```

`send({input, session})` → `send(item: In)`: the `session` parameter is deleted; world identity rides in `In` (§2.4). The `RuntimeContext` coloring should be made uniform — recommend adding it to all five methods (they are runtime verbs; the worker fixture only ever calls them inside `fetch`, `worker.ts:147-176`), or removing it from `send`; either resolves the current asymmetry.

### 3.2 Agent's derived channels

- **`Out = Message`** (the final assistant message — an opaque kernel type in Phase 1, refined in Phase 2). Not schema-derived: the agent's exit is kernel policy and stays that way.
- **`In`**: two options. *(Conservative, recommended for Phase 1)*: `In = unknown` — no term change at all beyond the service unification. *(Aggressive, flagged as a decision)*: derive from the agent's interpolated `Parameter` refs, mirroring `ToolParameters` (`Tool.ts:6-11`):

```ts
export type AgentIn<Refs extends any[]> =
  [Extract<Refs[number], Parameter>] extends [never]
    ? unknown
    : { [P in Extract<Refs[number], Parameter> as P["~alchemy/Name"]]:
          P["schema"]["Type"] };
// Engineer interpolates ${issue} → AgentIn = { issue: IssueRef }
```

This is consistent with "interpolation is dependency declaration" and would make `Fix`'s charter-level promise ("give ${Engineer} … the issue") a typed fact. Risk: agents interpolate parameters as *vocabulary*, not always as inputs (`Triage` mentions `${issue}` twice with different roles, `fixtures/org/agents.ts:35-39`). Recommend shipping the conservative default and spiking the derivation separately.

### 3.3 Kernel: one `interpret`

```ts
// src/AI/Kernel.ts
export type TermService<T> =
  T extends Loop<infer O, infer I, infer E, any, any, any[], any> ? LoopService<O, I, E>
  : T extends Agent<any, infer Refs, any, any> ? AgentService<AgentIn<Refs>>
  : never;

export type TermReq<T> =
  T extends Loop<any, any, any, infer R, any, any[], any> ? R
  : T extends Agent<any, any[], any, infer R> ? R
  : never;

export interface KernelService {
  readonly interpret: <T extends Agent<any, any[], any, any>
                        | Loop<any, any, any, any, any, any[], any>>(
    term: T,
  ) => Effect.Effect<TermService<T>, KernelError, TermReq<T>>;
  readonly events: Stream.Stream<KernelEvent>;
  readonly trace: (ring: string, after?: number) => Stream.Stream<KernelEvent, KernelError>;
}
```

`AI.layer`'s `isAgent` branch (`Kernel.ts:131-140`) collapses to `kernel.interpret(term)`. If migration comfort is wanted, keep `agent`/`loop` as deprecated one-line delegates; they carry no independent semantics.

### 3.4 What does NOT change

- **Term constructors and syntax**: `AI.Agent<Self>()(name)` and `AI.Loop<Self>()(name)` tagged templates, `~alchemy/Kind` discriminants, `{name, template, refs}` payloads — untouched.
- **Charters**: not one fixture template changes (`fixtures/org/loops.ts`, `agents.ts`).
- **Ref extraction / `Req`**: `Services.ts` untouched; `Env` is orthogonal to the unification (§1.4, last law).
- **Channel derivation**: `LoopOut/LoopIn/LoopErr` (`Loop.ts:20-50`) unchanged.
- **Capability denial**: the audits in `Org.types.ts` operate on term type parameters and Layer closures, neither of which moves.
- **The taxonomy stance**: Agent still has no control refs; the execution ring's exit remains kernel policy, now expressed as *fixed default types* rather than an absence with an untyped service.
- **Control refs, lint, errors, EventSource, Observe**: all untouched.

### 3.5 Fixture verification (reasoned, not run — read-only exercise)

- `fixtures/org/loops.ts`, `agents.ts` — construct terms only; constructors unchanged ⇒ type-check.
- `Org.types.ts` — extracts `Loop` type parameters (positions unchanged, `Org.types.ts:50-60`) and Layer closures via `AI.layer` (signature shape unchanged) ⇒ type-check.
- `Loop.types.test.ts` — same term-level surface ⇒ type-check.
- `fixtures/org/cloudflare/worker.ts` — `yield* Fix` still resolves the tag; `fix.dispatch({...})` unchanged member with unchanged signature (`worker.ts:157-176`) ⇒ type-check.
- `fixtures/org/cloudflare/kernel.ts` — the **one real migration site**: `AI.Kernel.of({ agent, loop, … })` (`kernel.ts:103-170`) becomes `AI.Kernel.of({ interpret, … })`, and the mock `AgentService` (`kernel.ts:108-112`) gains the four missing verbs (all `Effect.die` TODOs today, so this is mechanical). The `loop` arm's body moves under `interpret` with an `isLoop` branch — same code, one method.

Net: two mock TODO sites change; zero charters, zero audits, zero agent/tool definitions.

---

## 4. Trade-offs and failure modes

**Where this could over-abstract — and where the line is.** §9.5's warning ("our powers come from substituting implementations", don't design for hypothetical needs) and §8.5's rejection of "a uniform recursive loop construct" both bind here. The line this report draws:

1. **Unify the service shape** — cheap, mechanical, removes an accidental asymmetry (`void`/`any`/`session`), and is forced anyway the moment anything needs an agent's typed result (the Check verdict, the Fold output, any test that drives an agent directly).
2. **Do not unify the term kinds.** The residual distinction between Agent and Loop is *real and of a different kind than the services suggest*: the control refs are the parameters of the `serve∘hylo` constructor — an **arrow transformer** — and `Loop` is the only syntax permitted to supply them. `Agent` is the only term the kernel accepts as an atomic body arrow (and the only kind `Check`/`Fold` accept — keep `A extends Agent` at `Check.ts:33`, `Fold.ts:31`: a ring in judge position would put an unbounded process inside an iteration boundary, which is a lint-grade absurdity). Erasing the term distinction would (a) let charters override the ring-2 exit that Codex-grade prompt lore owns (codex.md Insight 5), (b) flatten "rings iterate over *different types* of state" into the uniform construct every source rejects, and (c) destroy the prose DX — agent templates are instructions to a model; charters are policy wiring.
3. **Do not expose `Channel` in any public signature.** It is the correct semantics and a fine internal implementation target for `AI.Kernel.memory`; as an interface it is seven variance-laden type parameters that the org author never needed.

**Failure modes to watch:**

- *Aggressive `AgentIn` derivation* (§3.2) could misread vocabulary-mentions as inputs. Ship conservative; spike separately.
- *`send`-vs-`dispatch` divergence*: if `send` ever grows semantics beyond "admission without join" (e.g. its own delivery guarantees), the identity `dispatch = send + await` breaks and we have two protocols again. The conformance suite should assert the identity.
- *`steer` under concurrency*: the unified service inherits the existing ambiguity (which run?). The model says the answer is the work-item key; typing that is Phase 2, but the interface comment should say so now rather than let harnesses guess (Codex's typed steering rejections are the reference, codex.md Insight 12).
- *`run()` temptation*: keeping `run()` on the service invites memory-harness code to treat "a resident fiber" as the definition of a served ring. It is one implementation of elimination (3); the Cloudflare harness's "running means reachable" is another. The doc comment should state that `run()` is `effect ∘ serve`, not a primitive. *(v2: this worry resolved itself by demotion — with auto-delivery removed, `run()` is vestigial; see the [addendum](#v2-addendum).)*
- *Perpetual-agent confusion*: `AgentService.dispatch: Effect<Message>` resolves per turn even though the agent-as-conversation is perpetual — because perpetuity lives in the *serving* (the inbox never ends), not the run. This is the same run/ring split as loops; the unification makes it uniform rather than introducing it.

**If the honest verdict had been "keep them fully distinct":** the mathematical argument would have to be that Agent and Loop have different *kinds* — arrow vs arrow-transformer. That argument fails at the service level: once constructed, a Loop term denotes an arrow-with-serving exactly as an Agent does (both are `Term → Process`); the transformer is the *constructor's parameters* (the control refs), not the constructed object. The kind distinction is real, and it lives precisely where this report keeps it: in the term language. The services were never two things.

---

## Appendix: source-of-truth citations for the load-bearing claims

| Claim | Kind | Citation |
|---|---|---|
| `AgentService.send({input, session?}) → Effect<void, never, RuntimeContext>` | code | `src/AI/Agent.ts:54-59` |
| `LoopService.{dispatch, run, steer, interrupt}` | code | `src/AI/Loop.ts:62-82` |
| `Out`/`In`/`Err` derived from Halt/Trigger/Budget refs | code | `src/AI/Loop.ts:20-50` |
| Kernel has separate `agent`/`loop`; `AI.layer` branches on `isAgent` | code | `src/AI/Kernel.ts:76-85, 131-140` |
| Check/Fold hold `agent: A extends Agent` (positional arrows) | code | `src/AI/Check.ts:32-40`, `src/AI/Fold.ts:30-38` |
| Observe contributes no `Req` | code | `src/AI/Services.ts:21-23`, `src/AI/Observe.ts:26-47` |
| Admission inbox is the primitive; interrupt is a control admission | code (mock) | `test/AI/fixtures/org/cloudflare/kernel.ts:42-57, 150-158` |
| Typed end-to-end dispatch in the org | code (mock) | `test/AI/fixtures/org/cloudflare/worker.ts:157-176` |
| "A loop is `In → Effect<Out, Err, Req>` lifted over a trigger stream" | design doc | §1.2.1 (line 63) |
| Execution loop "deliberately has no halt term; exit is kernel policy" | design doc | §8.2 ring mapping (~line 946) |
| "Termination is policy" | design doc | §2.4 (line 520) |
| Steering = feedback at the iteration boundary, resets step allowance | design doc | §9.3 (line 1079); §2.1 note (line 436) |
| No durable run entity; run-activity is derivable | design doc | §9.5 (line 1120); opencode.md Insight 6 |
| Session identity from world identity is the pending decision | design doc | §9.3/§3.1 two-plane discussion; task brief |
| `ToolLoopAgent` adds nothing to the loop | survey | ai-sdk.md §1 (line 27) |
| `result.output` throws on tool-call stop (untyped halt) | survey | ai-sdk.md §2.1 (line 70), Insight 3 |
| Agent loop as a workflow | survey | mastra.md §overview (line 11) |
| Session→Task→Turn; SQ/EQ; steering rejection vocabulary | survey | codex.md §1, §6, Insight 12 |
| Admit/promote inbox; "Session Drain has no durable identity" | survey | opencode.md §2.1, §2.5 |
| Task mode vs conversation mode leaks through the runtime | survey | eve.md §2.1, §3 (weakness 7) |
| `Channel<out OutElem, out OutErr, out OutDone, in InElem, …, out Env>` | effect v4 | `node_modules/effect/dist/Channel.d.ts:117, 171-173` |

---

<a id="v2-addendum"></a>

## v2 addendum — the actor/message reading (July 2026)

The design converged (four owner review rounds; canon:
[designs/ai/business-processes.md](../business-processes.md)) on an
**actor system whose behaviors can be written in prose** as the resting
model. This addendum records how that resting point lands on the
algebra above: mostly as a change of *primary interpretation*, once as
a genuine demotion, and nowhere as a refutation of the math.

### A.1 The actor reading is now the primary interpretation

The report derived one semantic object — `Process<In, Out, Err, Req> =
In → Run<Out, Err, Req> ≅ Channel` — and read it operationally as
"loop = serve(hylo(body))". The resting model reads the **same object**
as an actor, and that reading is now primary:

| Algebra (this report) | Actor reading (canon) |
|---|---|
| a **run** of the interpreted process | an **actor**: created by its first message, identity = `(term, work item)` — the virtual-actor discipline (exists on first message, addressed by identity) |
| the admission mailbox + serial drain (§2.4's admit-then-await) | the actor's **mailbox**, serial processing — kernel-internal |
| `send(item)` — the admission half | **tell** |
| `dispatch(item)` — admit + await `OutDone` | **ask** — and the human **Ask protocol** is the same pattern pointed at a person |
| `steer` — a write to the run's `InElem` at the iteration boundary | a **message to a running actor**, addressed by run key: `steer(runKey, msg)` (P0; resolves §2.5's flagged ambiguity exactly as predicted — the answer was the work-item key) |
| `interrupt` — Scope authority, not a channel op (§2.5) | **supervision**: Scope, budgets, parent-child interrupt cascade |
| `OutElem` — the emitted event stream | **broadcast**: typed `ctx.emit(EventSource, payload)`; an `EventSource` is a named broadcast channel, and an "event" is just a broadcast message |
| the term's behavior (charter / handler / codemode) | the actor's **behavior** — interchangeable Layers behind one tag; hot code swap = redeploy with a `promptHash` diff |

Two unifications the actor reading adds on top of the algebra:

- **Everything is a message.** An *instruction* is an addressed message
  (a plain schema — `In`); an *event* is a broadcast message
  (`OutElem`, typed by `EventSource`). The framework never
  distinguishes them; the contravariant/covariant position in the
  Channel is exactly the address/broadcast distinction, and the
  message's name and tense carry the rest.
- **Delivery is always explicit code.** The deterministic world (APIs,
  webhook front doors, cron, your DB transactions, denial/routing)
  sends; actors react. No process self-subscribes. This is what demotes
  the trigger-lift (A.2).

### A.2 The trigger-lift (`serve`, elimination 3) is DEMOTED

The one genuine supersession. §1.3's elimination (3) treated `serve :
Triggers<In> × Process → Run<never>` as a canonical elimination and
`run()` as its Effect view. The resting model removes **auto-delivery**
entirely:

- **`AI.when(X)` (renamed from `AI.on` in the signature reduction) is
  a pure input declaration** — it types `In`, renders in the prose,
  and appears in topology. No subscription runtime stands behind it;
  the kernel does not wire events to mailboxes.
- **Delivery is outside code**: the front door
  (`consumeRepositoryEvents`-style consumers, HTTP routes, platform
  cron) validates, denies, adapts transport payloads to domain
  messages, and picks the door — `send`/`dispatch` to create an actor,
  `steer(runKey, msg)` to reach a running one. The consuming call site
  carries the provisioning compile fence.
- **`AI.every` / `AI.each` are deleted** with it: cron is platform cron
  calling `send`; queues are consumers calling `send`.
- **`run()` is therefore vestigial.** The `Triggers<In>` monoid and the
  module-action law (§1.4) remain true of any stream you *choose* to
  drain into `send` in your own code — but the framework no longer
  performs the lift, and the mailbox drain is kernel-internal.

Nothing else in the eliminations moves: `dispatch` (1), the `stream` /
`AI.observe` projection (2), `steer` (4), and `interrupt` (5) are all
load-bearing in the actor reading — indeed (4) is *promoted* (run-key
steering is P0).

### A.3 "Everything becomes a Process" held up

The report's central claims survive intact:

- **Agent ⊂ Process** remains a denotational fact: an Agent term
  denotes a Process at kernel-default control parameters (§2.1). The
  service unification shipped in spirit: one `ProcessService`, the
  actor verbs (`dispatch`/`send`/`steer`/`interrupt` — `run()` is
  gone), one kernel `interpret`.
- **Deterministic / codemode / prose are Layer choices** behind one
  algebraic object — `AI.process(Term, ctor)` (effectful-constructor
  form is now canonical), `AI.layer(Term)`, `AI.layer(Term)` + codemode
  `ToolMode` Layers, or a hand-rolled `Layer.effect`. This is the
  report's "one semantic object, interchangeable interpretations"
  carried to its conclusion: the *behavior* of the actor is the only
  thing the Layer swaps.
- **Exits are unchanged**: `AI.until(schema)` (model-declared, graded),
  `AI.until(source, match)` (machine-observed; per-item `match`
  correlation is P0 — the halt-derives-`Out` law of §1.4 is
  untouched), `AI.never` (perpetual).
- **§2.4's verdicts landed**: `send` = the admission half of `dispatch`
  (now simply *tell* vs *ask*); the `session` parameter died — identity
  rides in `In` as the work item, which is exactly the actor's
  identity.
- **State never entered the algebra, and stays out**: a family of
  state constructs (`AI.state`, keyed ring families, `AI.Entity`) was
  explored and rejected in the review rounds (see
  `bp-ddd-event-storming.md` §4 for the full history). State is your DB
  outside the process, or a userland fold over the facts a run emitted
  (the Trace) — which the algebra already predicted: the fold-as-
  checkpoint law (§1.4) says the fold over `OutElem` is the only
  carried state.

### A.4 What to read where

- The canon (decisions, doctrine, build order):
  [designs/ai/business-processes.md](../business-processes.md).
- The DDD/Event-Storming embedding and the history of the rejected
  constructs: [bp-ddd-event-storming.md](./bp-ddd-event-storming.md).
- This report remains the reference for the formal model: the Channel
  denotation, the variance theorem, the hylo reading of the loop
  runtime, and the laws in §1.4 — all still in force under the actor
  vocabulary.
