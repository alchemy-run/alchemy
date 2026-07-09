# Alchemy AI — Design & Build Plan

**Agents, loops, and organizations as typed programs.**

Status: draft for implementation · Repo: `alchemy-run/alchemy-effect` · Module: `packages/alchemy/src/AI`

---

## 0. Vision

Alchemy AI is not a coding agent and not an agent harness. It is a term language plus a pluggable interpreter for describing **organizations of agents** — their roles, capabilities, feedback loops, and the infrastructure they run on — as a single Effect program that Alchemy provisions and deploys.

The founding observation: in every existing framework, an agent's prompt (prose) and its configuration (tools, memory, triggers) are separate artifacts that silently drift apart. In Alchemy AI, **the prose is the configuration**. Prompts are tagged template literals whose interpolations are typed references to tools, agents, loops, parameters, and control operators. Mentioning a tool in an agent's instructions is what places it in the dependency graph. The type system extracts requirements (`R`) from the template's refs, and `Layer` composition binds those requirements to physical infrastructure.

The stack of claims, from bottom to top:

1. **Prompts are typed terms.** Interpolation = dependency declaration. Description and schema are one artifact; drift is a type error.
2. **Declarations are pure data.** An `Agent`, `Tool`, or `Loop` term contains zero behavior — only `{ name, template, refs }`. Behavior comes from interpreters.
3. **The Kernel is a service.** The engine that runs terms is itself a `Context.Tag` provided by a `Layer`. Harnesses (in-memory, Cloudflare, wrapped third-party) are interchangeable interpretations of the same terms.
4. **The Kernel has no component vocabulary.** Memory, compaction, sandboxes, context policies, sub-agents — the Kernel interface knows none of these words. They exist only as services that particular Kernel *implementations* pull from their own `R`. This is the central architectural inversion relative to Mastra/LangChain-style frameworks, where such components are top-level framework concepts.
5. **Loops are the unit of organization.** Execution loop ⊂ task loop ⊂ product loop ⊂ system loop ⊂ oversight loop. Each ring is a charter (prose) with typed trigger, halt, fold, and budget refs. Loops of different scale share one grammar but iterate over different kinds of state.
6. **Authority flows down; information flows up.** Outer rings fork inner rings (interruption, budgets, supervision propagate down via Effect's fiber/Scope model). Inner rings communicate up only through return values, published events, and typed errors — never by calling upward.
7. **Loops couple through the world.** Between rings, communication crosses external durable surfaces (GitHub issues, PRs, Discord threads). This makes the org auditable, replayable, and human-legible by construction, and makes loops individually deletable.
8. **The fold is the unit of both memory and durability.** Compressing an iteration's history into carried state is simultaneously the memory strategy (compaction, observational memory, note-taking) and the durability checkpoint (what survives eviction). One operation, two payoffs.
9. **Autonomy is a Layer choice.** Human-in-the-loop capabilities (`Approve`, `AskHuman`) are ordinary Tools; whether a ring is an "orchestra" (human-supervised) or a "factory" (autonomous) is decided by which Layer implements those tools for that ring.
10. **The oversight loop is the source file.** Humans set goals by editing templates, allocate by adjusting budgets and Layers, and cull by deleting terms. Its interface is code review and `alchemy deploy`.

### 0.1 Prior art this design digests

- **Pi (pi.dev):** the minimal-kernel thesis, verified against source (§9): the true kernel is a ~790-line hook-parameterized loop whose 9-hook `AgentLoopConfig` (`transformContext`, `prepareNextTurn`, steering/follow-up queues, before/after tool call, …) is an empirically-discovered minimal seam checklist. Four tools is the *default loadout* (seven built-ins); sub-1k-token default prompt; skills = stable name+description+path index in the cached prefix, bodies loaded via ordinary `read` calls at the context tail. Extensions are typed at the signature level but compose by in-place mutation — the composition-level typing gap is exactly what our Layer algebra targets. Validates: keep the loop tiny; a tiny kernel interface survives years of production pressure; the harness above it inevitably grows named components (pi's compromise: default machinery + before/after events + full-replacement escape hatches).
- **OpenCode (anomalyco, ex-SST):** production Effect code in an agent harness — and its **v2 rewrite** (in flight, §9) is the strongest external validation we have: the 1,631-line v1 loop monolith, untyped EventEmitter bus, and AI SDK dependence were replaced by a durable **event-sourced core** (schema-defined versioned events, per-aggregate sequences, projectors inside the append transaction, replay with owner fencing), typed Context Epochs for prompt-cache stability, a durable admission inbox with steer/queue delivery, and their own LLM protocol layer. LSP diagnostics fed back into the loop as environment feedback (v1; v2 pending). Validates: the Effect service architecture works at this scale; sessions as durable logs with fold-like projections; and their `LayerNode` graph (scope-tagged layer composition with checked deps) is a warning about flat Layer graphs at app scale.
- **Mastra observational memory (OM):** context window split into an observation block plus a raw-message block; an Observer agent compresses messages into dated, priority-tagged observations (30k-token default threshold) and a Reflector consolidates observations past a second threshold (40k). The load-bearing mechanism (verified in source, §9) is **async buffering + instant activation**: the Observer runs in the background every ~20% of the threshold, sealing cache-stable chunks; crossing the threshold *swaps* buffered observations in at chunk boundaries without blocking the actor; activation is also forced on idle TTL and on provider/model change (the cache is invalidated anyway). Observation groups carry raw-message ranges with a paged `recall` drillback tool; an optional retrieval/indexing mode exists (default remains non-vector). Validates: memory as *continuous streaming fold* rather than episodic panic-compaction; folds should be buffered, cache-stable, and provenance-carrying.
- **Claude Code context management:** graduated five-layer compaction (per-tool-result budget caps → temporal snips → cache-oriented microcompact → context collapse → LLM auto-compact as last resort), oversized tool results persisted to disk and replaced with previews, subagents returning 1–2k-token summaries from 100k-token explorations. Validates: least-disruptive-first degradation; persist-outside-context-with-drillback; sub-agent isolation as a context strategy.
- **The loop taxonomy (Arize / Voss, 2026 — distributed by Dhinakaran; see §8):** four distinct architectures behind the word "loop" — execution loop (act–observe within a task), task loop (Ralph: restart against a spec with fresh context until tests pass), product loop (software factory: continuous, backlog-driven, no exit), system loop (autoresearch: iterates on the prompts/harness/evals themselves) — plus the human-held oversight loop above them. Key corrections adopted here: rings iterate over *different types* of state (the structure is indexed, not uniform); each loop is defined by its **exit signal**, and "naming a signal is not the same as wiring it in" — an unwired loop doesn't converge, it just runs; fan-out (dispatch/gather/validate) is a pipeline, not a loop, and gets no primitive; autonomy is a dial that exists separately on every ring.
- **Ralph loops (Huntley):** fresh context per iteration, one task per iteration, memory externalized into the repo/spec rather than carried state. Validates: the fold interface must span both directions — compress-into-state (OM) and deliberately-carry-nothing (Ralph, `fold = const(spec)`, memory in artifacts).
- **Cloudflare Project Think:** durable execution "fibers" in Durable Objects — `runFiber()` write-ahead journals to DO SQLite, `stash()` checkpoints mid-turn, `onFiberRecovered()` delivers the last checkpoint to a user-defined resume policy after eviction; automatic keepalive; sub-agent facets with isolated SQLite; tree-structured persistent sessions. Plus **Dynamic Workflows**: agent- or tenant-authored `run(event, step)` functions executed as first-class Workflows. Validates: the journal/stash/recover seam is real (Cloudflare independently converged on it for the gap between "alarm" and "Workflow"); our durability design should both implement this pattern natively and be able to wrap theirs.
- **Anthropic context-engineering guidance:** compaction / note-taking / sub-agent isolation as the three memory levers; "do the simplest thing that works."

### 0.2 What is genuinely new here

No prior system has: (a) prompts whose interpolations are compile-checked dependency declarations; (b) a kernel interface with zero component vocabulary; (c) loops as first-class typed terms whose **exit signal is the type** (`Out` is derived from the halt ref; an unhalted charter is typed perpetual, `Out = never`); (d) capability denial by absence-of-ref (a loop that never interpolates `${Approve}` cannot be granted merge authority by any Layer); (e) an organization whose memory stores, sandboxes, and event pipelines are provisioned by the same program that defines the agents (the Alchemy IaC substrate); (f) a system loop whose learning artifact is **pull requests against the org's own typed source**, review-gated like human changes.

---

## 1. Phase 1 — The term language (pure data representations)

Everything in this section is *data and types only*. No runtime behavior beyond object construction. This is the initial encoding; Phases 2–3 are its algebras.

"Term" is the broad word for every pure-data node of the language, but the kinds are not peers — they fall into three classes with different fates at interpretation time:

- **Process terms** — `Agent` and `Loop`. The only *interpretable* kinds (the `InterpretableTerm` union in `Kernel.ts`): each denotes a Process `In → Run<Out, Err>` and interprets into a live `ProcessService` with an admission mailbox and **one ring** (serial loop) whose lifetime is its Layer's. When we say "one loop per interpreted term", this is the only class being counted.
- **Capability terms** — `Tool` and `Parameter`. Never interpreted; *compiled into* their host process's turn: the tool's template becomes a toolkit description, its `Parameter` refs become the schema, its tag resolves to a handler from ambient context. No inbox, no run, no ring.
- **Control refs** — `Trigger`, `Halt`, `Fold`, `Check`, `Budget`, `Concurrency`, `Observe` (plus `EventSource`, which triggers consume). Parameters *of* a process term's ring: what feeds the mailbox, when a run exits, how state compresses, which ceilings fire. They configure loops; they aren't loops.

Splicing a process term into a charter (`${Engineer}` in Fix) contributes a *dependency on its tag*, never a new ring — how many rings exist is a Layer-composition fact: provide `AI.layer(Engineer)` once and memoization shares one Engineer ring across every referencing parent; provide a fresh copy per parent and each gets a private Engineer. The charter never decides this; the deployment does.

### 1.1 Existing terms (recap of current implementation)

Already in `packages/alchemy/src/AI`:

- `Parameter<Name, Schema, Refs>` — `AI.Parameter(name, schema)` tagged template. `~alchemy/Kind: "Param"`. The template is the parameter's description; description and schema are one artifact.
- `Tool<Name, Refs>` — `AI.Tool(name)` or `AI.Tool<Self>()(name)` tagged template. `~alchemy/Kind: "Tool"`. `ToolParameters<Refs>` extracts the params record type from interpolated `Parameter` refs. The `<Self>()` form makes the tool a `Context.Service`, so implementations are Layers (`Layer.effect(WriteFile, ...)`) and one interface admits many physics (`WriteFileR2`, `WriteFileDevBox`).
- `Agent<Name, Refs, Self, Req>` — `AI.Agent<Self>()(name)` tagged template. `~alchemy/Kind: "Agent"`. The `<Self>()` form makes the agent a **`Context.Service` tag** (see §1.4): yielding the class resolves the live `AgentService` *from context*, and `Req` is a phantom carrying the agent's *construction* requirements (its interpolated tool tags) — what its implementation Layer must be provided with.

Conventions preserved throughout: curried constructors, `~alchemy/Kind` discriminant, `{ name, template, refs }` payload, `Context.Service` classes for yieldability and Layer-based implementation.

### 1.2 New term kinds

#### 1.2.1 `Loop`

Channel-first type parameters, mirroring `Effect<A, E, R>` — a loop is `In → Effect<Out, Err, Req>` lifted over a trigger stream, and every channel is **derived from the refs**:

```ts
export interface Loop<
  Out = void,        // what a halted run resolves to — derived from the halt ref
  In = unknown,      // the work-item shape — derived from the trigger refs
  Err = never,       // abnormal exits — BudgetExceeded when a budget is declared
  Req = never,       // services — derived from all refs, incl. nested template refs
  Name extends string = string,
  Refs extends any[] = any[],
  Self = LoopService<Out, In, Err>,
> {
  [Symbol.iterator](): Effect.EffectIterator<Effect.Effect<Self, never, Req>>
  "~alchemy/Kind": "Loop"
  "~alchemy/Name": Name
  template: TemplateStringsArray
  refs: Refs
  new (): LoopService<Out, In, Err>
}

/** The live handle a Loop term interprets into. */
export interface LoopService<Out = void, In = unknown, Err = never> {
  /** Execute one run of the loop for a single work item. */
  dispatch(item: In): Effect.Effect<Out, Err>
  /** Serve the ring: consume triggers and dispatch runs until interrupted. */
  run(): Effect.Effect<never, Err>
}

export const Loop: {
  <Self>(): <Name extends string>(name: Name) =>
    <const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ) => Loop<LoopOut<Refs>, LoopIn<Refs>, LoopErr<Refs>, LoopServices<Refs>, Name, Refs, Self>
      & Context.Service<Self, LoopService<LoopOut<Refs>, LoopIn<Refs>, LoopErr<Refs>>>
  // + non-Self overload, mirroring Agent
}
```

Like Agent, the loop class is a **tag** (§1.4): `yield* Fix` resolves the live `LoopService` from context, and `AI.layer(Fix)` is its kernel-derived default implementation. Instances are branded with the loop's name so distinct loops stay distinct types (structural typing would otherwise collapse every perpetual `LoopService<never, …>` into one tag). One TS footgun, learned empirically: use the class name as a type (`Fix`), never `InstanceType<typeof Fix>` — the circular `class Fix extends AI.Loop<Fix>()(…)` heritage makes `InstanceType` silently resolve to `any`.

A `Loop` term is a **charter**: prose policy whose refs wire trigger, body, halt, check, fold, and budget. Interpolating an `Agent` delegates to it; interpolating another `Loop` nests it (the outer ring may dispatch typed runs of the inner ring — `dispatch` is typed `In → Effect<Out, Err>` end to end); interpolating a `Tool` grants the loop-level machinery that capability (e.g. a health-report `Reply`); `AI.observe(Loop)` references its Trace read-only, contributing nothing to `Req`.

`Out` is **run-scoped**: a *run* is the loop applied to one work item, and `dispatch` resolves when the halt condition is met. The *ring* — the stream of runs serving triggers — never resolves (`run(): Effect<never, …>`); a perpetual (`AI.never`) ring additionally has `Out = never`, so even a single run never returns.

#### 1.2.2 Control refs

Control refs are marker terms that only mean something inside a `Loop` (or, for `Budget`, also inside an `Agent`) template. Each is pure data with its own `~alchemy/Kind`.

```ts
// ── Triggers (derive `In`) ────────────────────────────────
export interface Trigger<In = unknown> {
  "~alchemy/Kind": "Trigger"
  mode: "on" | "each" | "every"
  sources: ReadonlyArray<EventSource<any> | Parameter | Cron>
}

AI.on(source, …more)  // wake on external events (variadic; In = union of schemas)
AI.each(param)        // consume a durable work queue of `param`-shaped items
AI.every("1 week")    // scheduled (cron / alarm); In = void
```

Triggers are not template tags — they carry no nested refs and contribute nothing to `Req`; their entire payload is the `In` channel.

```ts
// ── Halts (derive `Out`) ──────────────────────────────────
export interface Halt<Refs extends any[] = any[], Out = void> {
  "~alchemy/Kind": "Halt"
  "~alchemy/Out": Out              // phantom carrier for the resolution type
  mode: "until" | "never"
  schema: S.Top | undefined        // AI.until(schema) types the run's result
  template: TemplateStringsArray   // prose condition — may interpolate Tools
  refs: Refs                       // nested refs flow into the loop's Req
}

AI.until`a maintainer closes the experiment`            // Out = void
AI.until(PullRequestRef)`…resolve with the ${pr} the
Engineer opened`                                        // Out = PullRequestRef
AI.never`support does not halt while the product lives;
thread-resolution rate is the health signal`            // Out = never

// ── Checks (the positional verifier) ──────────────────────
export interface Check<A extends Agent = Agent, Refs extends any[] = any[]> {
  "~alchemy/Kind": "Check"
  agent: A                                   // the judge — never the doer
  template: TemplateStringsArray | undefined // optional per-ring grading policy
  refs: Refs
}

AI.check(Judge)`grade each iteration: run ${Bash} yourself — the
worker's claim of done-ness is not a signal; an off-goal verdict
becomes the next iteration's first input`

// ── Folds ─────────────────────────────────────────────────
export interface Fold<A extends Agent = Agent, Refs extends any[] = any[]> {
  "~alchemy/Kind": "Fold"
  agent: A                                   // folds are agents
  template: TemplateStringsArray | undefined // optional per-ring instructions
  refs: Refs
}

AI.fold(Scribe)`after every iteration, distill what was learned
into .alchemy/NOTES.md so iteration n+1 cannot repeat n's mistake`

// ── Budgets & concurrency (derive `Err`) ──────────────────
export interface Budget {
  "~alchemy/Kind": "Budget"
  limits: {
    tokens?: string; wallClock?: string; iterations?: number; usd?: string
    stall?: number   // max consecutive iterations without fold-visible progress
  }
}
AI.budget({ tokens: "5M", wallClock: "2h", iterations: 12, stall: 3 })

export interface Concurrency { "~alchemy/Kind": "Concurrency"; n: number }
AI.concurrency(3)

// ── Observation ───────────────────────────────────────────
export interface Observe<T extends Agent | Loop> {
  "~alchemy/Kind": "Observe"
  subject: T
}
AI.observe(Flywheel)   // trace access, not capabilities; contributes no Req
```

Design notes:

- **`until` is a nested template.** The halt condition is simultaneously human-readable policy and a typed dependency on concrete signals (the `${Bash}` ref). Nested refs flow into the loop's `Req` (§1.3). This is the load-bearing trick of the whole DX — spiked and confirmed. Bounded-by-machine and bounded-by-human are the same type: "a maintainer closes the experiment" is a halt signal arriving as a GitHub event, exactly like `${Bash}` reporting green.
- **The halt names *what* ends a run; the check names *who* judges it; the fold names *who* compresses it.** The check is the maker/checker split applied to the stop condition (§8: Osmani; Karpathy's immutable harness; Meta's held-out tracker; swyx draws the judge positionally inside the /goal ring). Like the fold it is a positional role invoked by the kernel at the iteration boundary, not at the model's discretion. Absent a check, the kernel's default judge policy grades the halt condition itself. The check's structural guarantee at term level is capability-shaped: the Judge's toolbox (run, read — never edit) is a different `Req` than the doer's; the kernel additionally enforces verifier-outside-write-scope at interpretation time (§2).
- **Budget ceilings are the "exits that always fire".** "Goal met" is the exit that might never fire; ceilings (hard limits + the `stall` no-progress detector) are typed as `BudgetExceeded` in `Err`, a failure for the parent to investigate, not a budget to spend. Stagnation *detection* (repetition, oscillation, diminishing delta) is kernel policy; the `stall` ceiling is what makes it a typed exit rather than a log line.
- **Folds are agents, not a special mechanism.** Ralph-style loops express "carry nothing" by folding into repository artifacts; OM-style loops fold into carried observation state. Same ref kind, opposite philosophies, chosen per-loop in prose. Bare `AI.fold(Scribe)` uses the agent's own template as the fold policy.
- **`each` vs `on` unify underneath.** Both denote a `Stream<In>` at interpretation time; `each` additionally implies a durable queue with acknowledgement semantics. Keep both constructors for DX, one runtime concept.
- **`observe` is the anti-delegation ref.** Interpolating a Loop delegates (its tag flows into `Req`, and resolving the service grants `dispatch` — the power to act); observing it grants trace access only. This is what lets the system ring study the rings it improves without inheriting `Approve` from them — the constitutional constraint, enforced by `Req`. **Decided (pending implementation):** observation is not `Req`-free forever — it should contribute a *read-grant tag* (`TraceRead<"Flywheel">`-shaped), never the ring's own tag: the deployment must explicitly grant "this ring may read that ring's trace" (a compile fence), and the grant Layer is where redaction/event-class filters live (§9.3's confidentiality note). The invariant that survives: observation can never grant the power to act, because the subject's service tag never enters the observer's `Req`.
- **Fan-out gets no term.** Parallel dispatch inside a body is `Effect.all` / `Stream` concurrency in the interpreter and `AI.concurrency` in the charter. A pipeline without feedback is not a loop and is not dignified with a Kind (§8.5).
- **Duplicate control refs are a lint, not a type error.** Construction stays total; `AI.lint(term)` (pure, data-only — runnable in tests, editors, and by the Kernel before interpretation) enforces cardinality and coherence: at most one budget/concurrency/fold/check (`error` — there is exactly one iteration boundary, so a second positional ref has no position, and merged-budget semantics would be a silent guess); at most one halt (`error` — two `until`s make `Out` an opaque union, and `until` + `never` is a contradiction that `never` silently absorbs at the type level); no halt at all (`warning: undeclared-perpetuity` — legal, `Out = never`, but a perpetual ring must say `AI.never` with its health signals); `until` without a budget (`warning: unbounded-until` — "goal met" is the exit that might never fire). Multiple *triggers* are legal and meaningful: `In` is their union.

#### 1.2.3 `EventSource`, channels, and event schemas

Typed event families used by triggers and published by provider packages. `EventSource` follows the **binding idiom** exactly (see `designs/ai/reports/bindings-architecture.md`): the declaration is *pure definition data* — name, schema, and `props` — and all behavior (provisioning and delivery) lives in the per-cloud Layer implementing the family's channel tag. There is no effect on a declaration anywhere in alchemy, and EventSource is no exception.

```ts
/** the harness-side delivery machinery for an event family */
export interface EventChannelService {
  // subscribe is the channel's analogue of a Binding.Service's
  // bind(resource): ONE call, TWO halves, guarded by __ALCHEMY_RUNTIME__
  // inside the Layer — plan time provisions the wire for the source's
  // props (Webhook resource, secret binding); runtime returns the stream
  // of verified, schema-decoded events.
  subscribe<In>(source: EventSource<In, any, any>): Effect<Stream<In>>
}

export interface EventSource<In = unknown, Channel = never, Props = unknown> {
  "~alchemy/Kind": "EventSource"
  "~alchemy/Name": string          // "github.issues.opened/owner/repo"
  "~alchemy/Channel": Channel      // phantom — flows into the loop's Req
  schema: S.Top & { Type: In }
  channel: Context.Service<any, EventChannelService> | undefined
  props: Props                     // pure config: repo ref, event name, filters
}

// provider packages declare one channel tag per event family…
export class GitHubEvents extends Context.Service<
  GitHubEvents, AI.EventChannelService
>()("GitHubEvents") {}

// …and constructors whose props tell the Layer what to provision/filter:
Github.IssueOpened(repo)
// : EventSource<IssueOpenedEvent, GitHubEvents,
//               { repo, event: "issues", filter: { action: "opened" } }>
```

This is how the pure representation reaches physical infrastructure — **declaring the subscription is what provisions the wire**:

1. *Pure representation* — `${AI.on(Github.IssueOpened(repo))}` in a charter puts `GitHubEvents` in the loop's `Req` (the trigger contributes its sources' channel tags — the one thing a trigger contributes, since it is not a template tag).
2. *Type-only requirement* — nothing runs until a Layer provides `GitHubEvents`; forget it and the deployment does not type-check. The channel Layer's own requirements are the **second, transitive compile fence**: `GitHubEventsLive` requires `GitHub.RepositoryEventSource`, so forgetting `GitHubRepositoryEventSourceLive` on the Worker also fails to compile.
3. *Infrastructure Layer* — the kernel, interpreting the loop's triggers in the host's init phase, resolves each source's channel tag from ambient context (the same mechanism as tool refs — §2.2) and calls `subscribe(source)`. The Cloudflare Layer dedupes wires per `(repo, event)`, then delegates to `GitHub.RepositoryEventSource` — whose Worker implementation **provisions a repository `Webhook` resource pointing at the Worker at deploy time** (FQN-deduped, namespaced under the host) and registers the signature-verifying delivery listener at runtime. Provisioning is driven by the union of *subscribed* sources' props — never a side list, so a charter subscribing to a new repo provisions its webhook by construction. A source with no channel (`Channel = never`) is kernel-internal — deliverable only by the harness's own bus (tests, `AI.Kernel.memory`).

Cross-loop coupling happens **only** through `EventSource`s and shared `Tool`s. No term may reference another loop's internals.

### 1.3 Type-level extraction (channels from refs)

All four channels are derived from the refs — implemented and verified:

```ts
// Req — a ref contributes its TAG. Transitivity moved out of the type
// computation and into Layer composition (§1.4): an agent's tools are
// requirements of the agent's Layer, not of every charter that mentions it.
type LeafServices<R> =
    R extends ToolImpl<any, any, infer Q>    ? Q    // inline impl: its own Req
  : R extends Context.Service<infer Id, any> ? Id   // Tool/Agent/Loop classes: the tag
  : never

export type RefServices<R> =
    R extends Halt<infer Inner, any>        ? LeafServices<Inner[number]>
  : R extends Fold<infer A, infer Inner>    ? LeafServices<A> | LeafServices<Inner[number]>
  : R extends Check<infer A, infer Inner>   ? LeafServices<A> | LeafServices<Inner[number]>
  : R extends Trigger<any, infer Channels>  ? Channels   // event-channel tags
  : LeafServices<R>              // Observe matches no arm: contributes nothing

export type Services<Refs extends any[]> =
  Refs[number] extends infer A ? RefServices<A> : never

// Out / In / Err
export type LoopOut<Refs> = /* Halt ref present ? its Out : never */
export type LoopIn<Refs>  = /* union of the Trigger refs' In */
export type LoopErr<Refs> = /* Budget ref present ? BudgetExceeded : never */
```

Nesting is deliberately capped at depth 1: control refs may contain Tool/Agent/Loop refs, but not further control refs — the sane semantic limit, and inference stays fast and legible (spike confirmed; the reference org type-checks in ~2s under the scoped tsconfig).

### 1.4 Terms are tags; implementation is Layer composition

Every `<Self>()`-form term — `Tool`, `Agent`, `Loop` — is a `Context.Service` **tag**. This is the load-bearing architectural decision of the implementation phase, and it answers "how does the pure representation reach the infrastructure":

```
pure representation  →  type-only Layer requirements  →  kernel + infra Layers
     (terms)              (tags in Req channels)          (Layer.provide graphs)
```

Consequences, each independently valuable:

1. **Interpolation contributes the tag, not the transitive closure.** `${Engineer}` in Fix's charter puts `Engineer` in Fix's `Req`. Engineer's *tools* are requirements of *Engineer's Layer*: `AI.layer(Engineer): Layer<Engineer, never, Kernel | Grep | ReadFile | EditFile | Bash | OpenPullRequest>`.
2. **Per-agent tool physics.** Because elimination happens per-Layer, two agents in one runtime hold different implementations of the same contract:

```ts
const EngineerLive = AI.layer(Engineer).pipe(Layer.provide(BashDevBox))   // read-write sandbox
const JudgeLive    = AI.layer(Judge).pipe(Layer.provide(BashReadOnly))    // same contract, run/read only
const FixLive      = AI.layer(Fix).pipe(Layer.provide([EngineerLive, JudgeLive, ScribeLive]))
```

   The maker/checker separation (§8) is now *physical*: the verifier's `Bash` can refuse mutation while the doer's cannot, in the same Worker.
3. **Custom implementations are ordinary Layers.** An Agent class is a plain tag, so `Layer.effect(Engineer, myImpl)` bypasses the kernel default entirely — the kernel is a convenience, not a privilege.
4. **Capability denial survives the move.** The transitive closure is now a *Layer-algebra fact*: composing `FixLive` with its agent layers yields `Layer<Fix, never, Kernel | Grep | … >` — and the type-level audit asserts `Approve` appears nowhere in that closure. The system ring is stronger still: `AI.observe` contributes no tag at all, so no Layer composition, however creative, can route `Approve` into Autoresearch — its `Req` cannot demand it.
5. **The kernel stack composes the user's way up.** The full deployment is one Layer pipeline (this is the shape the Cloudflare fixture implements):

```ts
const OrgLive = Layer.mergeAll(FlywheelLive, HelpdeskLive, AutoresearchLive, FixLive).pipe(
  Layer.provide([GitHubEventsLive, DiscordEventsLive]),   // channels (webhook provisioning)
  Layer.provide(CloudflareKernelLive),                    // Kernel over the Ring DO namespace
  Layer.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),  // the wire
)

export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()("Org",
  { main: import.meta.url },
  Effect.gen(function* () {
    const fix = yield* Fix                    // typed LoopService from context
    return { fetch: /* POST /issues/:n/fix → fix.dispatch(issue) : Effect<PullRequestRef, BudgetExceeded> */ }
  }).pipe(Effect.provide(OrgLive)),           // one Effect.provide, one composed Layer
) {}
```

`AI.layer(term)` is implemented as `Layer.effect(term, Kernel.pipe(Effect.flatMap(k => k.interpret(term))))` — the kernel resolves the term's ref tags from the ambient context at interpretation time, which is exactly why the Layer's requirements are `Kernel | term's Req`.

One TS footgun, learned empirically: refer to term instance types by class name (`Fix`, `Engineer`), never `InstanceType<typeof Fix>` — the circular `class Fix extends AI.Loop<Fix>()(…)` heritage makes `InstanceType` silently resolve to `any` (which then defeats every `Extract`-based assertion downstream). Instances are branded with the term's name so distinct terms stay distinct types.

### 1.5 The missing halt is a type, not an error

The taxonomy's sharpest lesson — a loop without its wired exit signal doesn't converge, it just runs — is encoded in the **`Out` channel**, not enforced at the constructor:

- A charter that wires no halt is typed **perpetual**: `Out = never`. Its runs are `Effect<never, …>` — unusable in exactly the right way. This mirrors Effect's own data flow: construction is total, and the missing signal is carried to the eliminator instead of erroring at the declaration.
- `AI.never` is the *explicit* declaration of perpetuity — same `Out = never`, but the prose must name the health signals that substitute for an exit.
- The Kernel lints **undeclared** perpetuity (no halt ref at all) at interpretation time — the runtime distinction between "typed as perpetual by omission" and "declared perpetual with health signals" is a kernel policy, not a type.

(The earlier `RequireHalt` constructor-constraint design was spiked and rejected: the circular tuple constraint degraded inference and produced arity errors instead of legible ones, and it made construction partial for no semantic gain — `Out = never` already prices the omission correctly.)

Rejected stricter variants, for the record: requiring ≥1 trigger (a triggerless loop is a valid dispatch-only work queue); forbidding budget-less `AI.until` loops (a real risk — but a kernel lint, not a constructor error, for the same reasons).

### 1.6 The renderer

A single canonical, **pure, deterministic** function from a term to prompt text:

```
render(term: Agent | Loop | Tool | Halt | Fold): string
```

Rules:

- `${Parameter}` inside a Tool template → the parameter's name, marked (` `path` `), with the parameter's own description contributing to the tool's JSON-schema `description` fields.
- `${Tool}` inside an Agent/Loop/Halt template → the tool's name plus (configurable) a one-line summary; full tool contracts render into the tool-schema section, not the prose, to preserve prompt-cache stability.
- `${Agent}` / `${Loop}` → the referent's name; the referent's own template is *not* inlined (delegation, not concatenation).
- Control refs render as structured sections after the prose (Triggers / Halt / Fold / Budget), or inline where interpolated — decide once in Phase 0 and never change (see next point).
- `promptHash = hash(render(term))`. Prompts are content-addressed: versioned like any resource, diffable in PRs, usable as prompt-cache keys, and comparable by the system loop across deployments. The renderer must therefore be dependency-free and clock-free.
- Shared `Parameter`s may need per-use description overrides (`ReadFile`'s `path` is "the file to read", not "the file to search"). Provide `param.as\`override\`` producing a derived Parameter; defer if Phase 0 shows it complicates extraction.

### 1.7 DX target (abbreviated; full org in §4)

```ts
// vocabulary
export const issue = AI.Parameter("issue", Github.IssueRef)`
A reference to a GitHub issue in one of our repos.`

// tools — interfaces; physics comes later
export class CreateIssue extends AI.Tool<CreateIssue>()("createIssue")`
File a new ${issue}. Title in conventional-commit style; body must
contain a minimal reproduction.` {}

export class Approve extends AI.Tool<Approve>()("approve")`
Request approval to merge ${pr}. Returns approved, or rejected
with reasons you must address before asking again.` {}

// agents — prose that hires tools
export class Engineer extends AI.Agent<Engineer>()("Engineer")`
You receive exactly one ${issue} whose acceptance criteria are your
entire specification. ${Grep} before you ${ReadFile}; ${ReadFile}
before you ${EditFile}. ${Bash} runs the tests after every edit —
all green is the only definition of done you may use.
You do not review your own work, and you do not merge.` {}

// the positional verifier — grades work it did not do; run and read, never edit
export class Judge extends AI.Agent<Judge>()("Judge")`
You grade work you did not do, against a spec you did not write.
Verify each criterion mechanically: ${Bash} to run the suite
yourself, ${ReadFile} to inspect the diff. You never edit.` {}

// loops — charters with typed control refs
export class Fix extends AI.Loop<Fix>()("Fix")`
One issue, one loop, one task per iteration.

${AI.each(issue)} give ${Engineer} a completely fresh context:
the issue, its criteria, CONTRIBUTING.md, and .alchemy/NOTES.md.
Carry no conversation history — the repo and the notes are the
only memory this loop is allowed.

${AI.until(PullRequestRef)`every acceptance criterion is checked
and the run resolves with the ${pr} the Engineer opened`}

${AI.check(Judge)`grade each iteration: run ${Bash} yourself — the
Engineer's claim of done-ness is not a signal; an off-goal verdict
becomes the next iteration's first input`}

${AI.fold(Scribe)`distill lessons into .alchemy/NOTES.md after
every iteration, successful or not`}

${AI.budget({ tokens: "5M", wallClock: "2h", iterations: 12, stall: 3 })}` {}

// typed end to end: In = IssueRef, Out = PullRequestRef, Err = BudgetExceeded
// Req = Grep | ReadFile | EditFile | Bash | OpenPullRequest | CreateIssue
```

Capability denial by omission: a charter that never interpolates `${Approve}` has no `Approve` in its `Req`; no Layer can grant it merge authority. Constitutional constraints on the system loop are enforced by the type system, not by prose.

**Phase 1 deliverables:** `Loop.ts`, `Trigger.ts`, `Halt.ts`, `Check.ts`, `Fold.ts`, `Budget.ts`, `Errors.ts`, `EventSource.ts`, `Observe.ts`; extended `Services`; renderer + `promptHash`; type-level test suite covering channel derivation, ref extraction, nested-template flow, capability-omission, observation-without-inheritance; renderer golden tests. *Status: all terms landed and verified against the reference org (`test/AI/fixtures/org`, audited by `test/AI/Org.types.ts` + `test/AI/Loop.types.test.ts`); renderer + `promptHash` outstanding.*

---

## 2. Phase 2 — The Kernel service

### 2.1 The interface (landed in `src/AI/Kernel.ts`)

The Kernel is the interpreter of terms. It is one `Context.Service` with a deliberately small surface — this is now implemented (the interface; implementations are mocks until Phase 2 proper):

```ts
// packages/alchemy/src/AI/Kernel.ts (as landed)
export interface KernelService {
  /** Interpret a PROCESS term (Agent | Loop — the only interpretable
      kinds) into its live service. Agent and Loop denote the same object
      — a Process `In → Run<Out, Err>` — differing only in who supplies
      the control parameters (kernel defaults vs charter refs), so
      interpretation is ONE method. R = the term's own Req plus Scope:
      the kernel resolves the term's ref tags from ambient context, and
      interpretation acquires the term's ring (one serial mailbox-drain
      loop whose lifetime is the Scope's — AI.layer discharges it into
      the Layer's lifetime). Capability terms and control refs are never
      interpreted; they are compiled into their host's turn/ring. */
  readonly interpret: <T extends InterpretableTerm>(
    term: T,
  ) => Effect.Effect<TermService<T>, KernelError, TermReq<T>>
  // TermService<Loop<O,I,E,…>> = LoopService<O,I,E>; TermService<Agent…> = AgentService

  /** Live firehose: all interpreted process terms' events, deltas included.
      No replay guarantee — for dev UIs and dashboards. */
  readonly events: Stream.Stream<KernelEvent>

  /** Durable replay-then-tail over one ring's Trace, from a seq cursor.
      What folds consume and what AI.observe grants access to. */
  readonly trace: (ring: string, after?: number) => Stream.Stream<KernelEvent, KernelError>
}

export class Kernel extends Context.Service<Kernel, KernelService>()("alchemy/AI/Kernel") {}
```

That is the whole contract. Note the vocabulary that is **absent**: memory, compaction, context, sandbox, session-store, sub-agent, model. The Kernel interface has no opinion about any of them.

**One service shape, two process terms** (the Agent/Loop algebra, `designs/ai/reports/agent-loop-algebra.md`): interpreting a process term — Agent or Loop, the only interpretable kinds (§1 taxonomy) — produces a `ProcessService<Out, In, Err>` — semantically a *Process* `In → Run<Out, Err>` whose denotation is Effect's `Channel` (events out, steering in, halt-derived `Out`, `Req` as Env), with the public surface kept to the Channel's five canonical eliminations:

```ts
export interface ProcessService<Out = void, In = unknown, Err = never> {
  dispatch(item: In): Effect<Out, Err, RuntimeContext>  // admit + await the done value
  send(item: In): Effect<void, never, RuntimeContext>   // the admission half alone
  run(): Effect<never, Err, RuntimeContext>             // the trigger-lift (never is structural)
  steer(input: unknown): Effect<void, never, RuntimeContext>  // InElem, promoted at the boundary
  interrupt(): Effect<void, never, RuntimeContext>      // Scope authority, via the same inbox
}
// LoopService<O,I,E> extends ProcessService<O,I,E>       (channels from refs)
// AgentService<I,O>  extends ProcessService<O,I,never>   (channels from kernel defaults)
```

The verdict that shaped this: Agent ⊂ Loop *denotationally* (an Agent is the hylomorphism at kernel-default control parameters: trigger = the inbox, halt = "no more tool calls", fold = the transcript) and Loop = iterated-agent *operationally* — but the **term kinds stay distinct**, because the control refs are parameters of an arrow *transformer* that only charters may supply: collapsing the terms would let prose override the execution ring's exit, which is model-behavior lore the kernel owns (§8.2, §8.5). `Check`/`Fold` keep `A extends Agent` — "agent" in a positional role means exactly "arrow the kernel interprets". Three consequences landed with it: `session` is **deleted** (a run is keyed by `(term, work item)`; world identity rides in `In` — the Discord thread, the GitHub issue); `send = dispatch − join` is a conformance-suite identity, not a second protocol; and `Err = never` on agents is a theorem (tool errors are model-visible results; harness failures are `KernelError`).

The two event surfaces are deliberately *not* unified (§9.3, learned from OpenCode v2): the live stream includes ephemeral deltas and may drop on disconnect (consumers refresh and resubscribe); the trace is cursor-bearing and replayable, and observation over it is a pure storage read — it neither wakes the ring nor resets any keepalive. `steer` delivers durable mid-run input at the next iteration boundary (resetting the step allowance; under `AI.concurrency > 1` it needs a run key — the work item's world identity — typed in Phase 2); `interrupt` settles in-flight tools as interrupted results, folds, and leaves a model-visible marker in the Trace. The richer handle surfaces (`status`, per-handle streams) harden in Phase 2.

### 2.2 How terms bind to implementations

Term refs are `Context.Service` classes. The Kernel resolves them **from the ambient Effect context** at interpretation time:

```ts
// inside a Kernel implementation:
const impl = yield* Effect.serviceOption(toolRef)   // e.g. WriteFile
```

Consequences: `kernel.interpret(term)` carries the term's `Req` in its requirement channel, so it can only run where every ref's tag is provided — and `AI.layer(term)` (§1.4) packages exactly that into the term's default Layer:

```ts
// src/AI/Kernel.ts (as landed)
export const layer = (term) =>
  Layer.effect(term, Effect.gen(function* () {
    const kernel = yield* Kernel
    return yield* kernel.interpret(term)
  }))
// AI.layer(Engineer): Layer<Engineer, never, Kernel | Grep | ReadFile | EditFile | Bash | OpenPullRequest>
```

Providing `WriteFileR2` vs `WriteFileDevBox` is invisible to the Kernel; it just gets *a* function `(params) => Effect` — and because provisioning is per-term-Layer, different agents in one runtime resolve different physics for the same contract.

#### The interpretation pipeline (terms → effect/ai)

`interpret(term)` is a three-stage compiler plus a driver, built on `effect/unstable/ai` (`LanguageModel`, `Tool.dynamic` — runtime schemas, exactly what terms are — `Toolkit`, `Chat`, `Response.StreamPart`; providers `@effect/ai-anthropic`/`-openai`):

- **Stage A — link** (init phase, once per Layer construction): walk `term.refs` and compile — Tool tags resolve their impls from ambient context and become `Tool.dynamic` + Toolkit handler entries (description = the rendered tool template; parameters from the interpolated `Parameter` refs); interpolated Agents/Loops resolve their `ProcessService`s and become **delegation tools** (handler = `dispatch`, parameters = the callee's `In` schema — agent-as-tool with summary return); trigger sources `subscribe` (the two-phase bind); `AI.until(schema)` becomes a synthetic `resolve` tool + `give_up` (halt-as-tool, §9.3); human-class tools become tools whose handlers issue `Ask`; Check/Fold agents stay **out of the toolkit** — they are positional arrows invoked by the kernel at the boundary. Products: one `Toolkit.WithHandler`, the rendered prompt + `promptHash`, trigger streams, control parameters. *Status: Tool compilation, delegation tools (summary return: `Completed → text`, typed loop exits → model-visible failure text; `task: string` params pending the callee-`In` schema), and halt-as-tool are landed in the memory kernel; trigger subscribe, Ask-backed tools, and `promptHash` are not yet.*
- **Stage B — the turn driver**: the §2.4 step machine drives `LanguageModel.streamText({ prompt, toolkit, toolChoice })`; stream parts arrive as `Feedback`, commands go out, budgets decrement per command, pairing repairs on read. `Chat`'s serializable state is a candidate transcript carrier inside `StepState`.
- **Stage C — the loop runtime**: the §2.5 hylomorphism — triggers → admission → per work item, iterate Stage-B turns; at each boundary drain steers, run Check (verdict), run Fold (checkpoint), decide (goal-met / `Refused` / ceiling / interrupt).

The model provider is the `LanguageModel` Layer — one more piece of per-term physics, overridable per agent exactly like `Bash`.

### 2.3 Kernel events

A closed core set plus an open extension channel:

```ts
export type KernelEvent =
  | TurnStarted     | TurnEnded
  | ModelRequested  | ModelDelta   | ModelCompleted
  | ToolRequested   | ToolCompleted | ToolFailed
  | IterationStarted | IterationFolded
  | LoopTriggered   | LoopHalted   | BudgetExceeded
  | Escalated       // AskHuman-class events
  | Custom<{ tag: string; payload: unknown }>
```

Every event carries `{ ring: LoopName[], term: promptHash, session, workItem, cause, auth }` provenance — `cause` is the parent command / trigger ref that produced the event (a seam without provenance rots; pi's users monkey-patched privates to get it), and `auth: { initiator, current }` distinguishes human-initiated from ring-initiated work so approval policies and budgets can be caller-sensitive. **The persisted event stream is the Trace** — the single representation used by folds (memory), by durability (journal/replay), by observability (OTel export), and by the system loop (autoresearch input). Do not invent a second representation for any of these.

Schema discipline, adopted from the harness survey (§9.3) and landed in `src/AI/Kernel.ts`:

- **Versioned from v1** (`v: 1`). Unversioned durable payloads forced OpenCode to reset history twice; Eve migrates every durable envelope.
- **Deterministic ids.** Durability-relevant events derive `id` from `(term, session, turn, callId/ordinal)`, never minted at emit time — replay collides idempotently.
- **Durable vs live is a type-level split.** Deltas (`ModelDelta`, tool-input fragments) are `durable: false`: they can never advance a trace cursor, never replay, and are excluded from folds. Only durable events carry `seq` — the per-ring sequence that is the *only* cursor.
- **Emission ordering is normative**: `ToolRequested` is emitted before any gate; a blocked/denied call is a distinct terminal event from a failed one (denials are among autoresearch's most informative signals).
- Redaction classes exist in the schema from v1 (the Trace carries prompts and tool payloads; observation grants should be able to filter event classes).

### 2.4 The pure step machine (normative for all Kernel implementations)

Every Kernel implementation MUST structure its agent turn as a pure transition plus a command interpreter:

```ts
// serializable — no handles, no sockets, no clocks
export interface StepState { messages: ...; budget: ...; phase: ... }

export type Command =
  | CallModel  { request }
  | CallTool   { name; input; callId }
  | Emit       { event }
  | Ask        { tool: "human-class"; payload }        // durable waits
  | ForkLoop   { loop; workItem }
  | Checkpoint { }                                     // fold + persist
  | Halt       { result }

export type Feedback =                                  // command results
  | ModelResponse | ToolResult | AskAnswer
  | Steered      // mid-run input, delivered only at the iteration boundary
  | Recovered    // post-eviction resume, carrying the recovery classification

step: (state: StepState, fb: Feedback) => readonly [StepState, Command[]]
```

Rules (amended per §9.3):

- `step` is **pure and deterministic**: no `Clock`, no `Random`, no I/O, no id generation (ids arrive in feedback or derive from `(session, stepIndex, ordinal)`), and **nothing in `StepState` closes over a function** — schemas included (the AI SDK's workflow layer pays an Ajv-revalidation tax for exactly this; Mastra built a global TTL-cache registry to smuggle closures). Timestamps and perf metrics are interpreter-side annotations on Trace events, never inputs to `step`. Conformance test: every `StepState` survives `structuredClone` + process restart.
- The Kernel owns the **tool-pairing invariant**, broadened: every `CallTool` command is answered by exactly one `ToolResult` feedback — including **policy blocks** (a blocked call synthesizes a real result the model sees; a skipped call with no result makes the model invent success — the confabulation trap), **interruption/abandonment** (typed "interrupted" results, never silent re-execution), and **truncated arguments** (a `length`-truncated call batch fails wholesale — salvage-parsed JSON may validate while incomplete). Enforced as **repair-on-read**: a pure normalization pass over Trace-derived messages with deterministic synthetic fills, composing with any fold or trim. Provider-executed deferred results are a typed exemption. Suspension bookkeeping keys on `callId`, never tool name (parallel identical calls must both resume).
- **Budget accounting is per-command and transactional**: every `CallModel`/`CallTool` feedback updates budget state; ceilings may fire between any two commands (checking only at iteration boundaries lets a long tool loop blow through the window — pi #4325). Decrements commit in the same transaction as the fold/Trace write. Usage follows the AI SDK v4 shape (cache-read/write/uncached splits, every count possibly absent) with a declared policy for unknown usage.
- **Durability doctrine**: resume + repair is the conformance floor — on recovery, orphaned in-flight work is failed as typed interruptions, the last fold is delivered, and the `Resume` policy decides `Continue | Retry | Terminal`; recovered checkpoints carry the `promptHash` they were created under, and a mismatch with the deployed term routes to policy (never blind `Continue`). Byte-exact deterministic replay is the Workflow-tier stretch (the step machine makes it *possible*; no surveyed system ships it, and none needed it to be reliable).
- **Model choice is per-turn data**: `CallModel` carries the model resolved at interpretation time (kernel default ← ring policy ← agent Layer override), so Judge-on-cheap-model and mid-run switches need no Layer recomposition; cross-model continuation strips provider-native metadata.
- Sub-agents are **not a Kernel feature**. An agent wrapped as a tool is delegation; `ForkLoop` covers loop nesting. Isolation and summary-return fall out of composition. `ForkLoop` children are durably parent-linked by the forking event id; parent-scope death settles the fork as a typed interruption while retaining the child Trace; child budgets are **leases** split from the parent's remainder, reconciled on completion.
- **`Ask` is the one durable-wait primitive**: approval, structured question (2–4 options), OAuth, and budget-continuation are payload kinds of the same park-until-correlated-answer protocol. Answers are *verdict + optional amendment* (an approval may carry a durable policy delta — "approved for session", "never ask for this pattern" — persisted as fold-visible ring state, so the autonomy dial ratchets by use with the history in the Trace) or *correction* (typed feedback re-entering the loop). Declines are typed `denied` results the model sees; unrelated input during a pending ask is held, never treated as denial; asks are signed and answers verified (they arrive over world surfaces).
- Termination is policy: "model returned no tool calls" is merely the default; `Halt` refs, budgets, and human interrupts are other producers of the same `Halt` command.

### 2.5 The loop runtime (normative semantics)

```
triggers (merged Streams) ─┐
steers / controls ─────────┴→ ONE ordered, idempotent admission inbox
  → admit work item (dedupe by delivery id; respect Concurrency, Budget)
  → iteration: run body (agent turns / inner-loop forks) → Trace
  → drain steers (promote at the boundary; reset the step allowance)
  → check: Check agent grades the halt condition against the Trace
           (default judge policy when no Check ref). Verdicts are
           four-valued: goal-met | off-goal(feedback → next iteration's
           first input) | waiting(stop, ask the human, stay active) |
           check-failed(park with reason — a broken judge NEVER re-loops)
  → fold: (carried, Trace) → carried'          // an Agent invocation or const
  → halt: goal-met | Refused (ratified give-up) | budget/stall ceiling
          | interrupt → LoopExit
  → repeat
```

The cheapest correct implementation of `AI.until(schema)` is **halt-as-tool** (§9.3): the kernel injects a synthetic `resolve` tool whose input schema is the halt schema (plus `give_up` for the typed refusal); the model calls it, the check grades it, schema-invalid calls bounce back as tool errors for self-correction, and a turn ending with neither gets a bounded nag. Exit-condition prompts (the default judge's completion audit, the give-up evidence bar) are load-bearing kernel assets — versioned with `promptHash` regression tests, not afterthoughts.

- Triggers, `each`-queues, and cron unify as `Stream<In>` at this level; durability of the stream is the harness's problem.
- **Downward:** iterations and inner loops run as child fibers in the ring's `Scope`; interruption, budget decrement, and supervision propagate automatically.
- **Upward:** three channels only — (1) the iteration's return value (distilled result; the subagent-summary pattern); (2) published `KernelEvent`s, which parents may subscribe to *as triggers* (upward comms reuse the trigger vocabulary; no second mechanism); (3) typed errors (`BudgetExceeded`, etc.) caught by the parent as escalation policy. The softest escalation is ordinary tool use: `${AskHuman}` reaches the oversight ring through vocabulary, not plumbing.
- **Sideways (cross-ring):** through the world only — `Tool` side effects producing `EventSource` stimuli (Support files an issue → Flywheel wakes). The harness must not offer a private cross-ring channel.

### 2.6 The in-memory reference Kernel (`AI.Kernel.memory`)

Ships in Phase 2 as the executable spec, the `alchemy dev` runtime, and the test harness:

```ts
export const memory: Layer.Layer<
  Kernel,
  never,
  AiLanguageModel                     // from @effect/ai — user picks provider
> = Layer.effect(Kernel, Effect.gen(function* () {
  const model = yield* AiLanguageModel
  const policy = yield* Effect.serviceOption(ContextPolicy)   // internal seam
    .pipe(Effect.map(Option.getOrElse(() => ContextPolicy.truncate)))
  // ... construct agent()/loop() from step-machine + Stream loop runtime
}))
```

Note the pattern that Phase 3 generalizes: `ContextPolicy` is a service **of this implementation**, exported for override, defaulted internally, and *absent from the Kernel interface*. Default policy: naive truncation. OM, tiered compaction, Ralph-fresh-context are alternative Layers a user provides *to the kernel layer*, and the Kernel tag never learns their names.

**Phase 2 deliverables:** `Kernel` tag + handle types; `KernelEvent` + Trace schema; pure step machine + property tests (tool-pairing invariant under arbitrary trims; determinism under replay); loop runtime on Streams; `AI.Kernel.memory`; in-memory `EventBus`/`TraceStore`; the `ProcessService` verbs wired to `Kernel.interpret` (asserting the `dispatch = send + await` identity); conformance test suite that any Kernel Layer must pass (run it against `memory`; reuse verbatim against Cloudflare in Phase 3); non-executing interpreters as proof of the algebra: `PlanKernel` (render + validate + diff promptHashes) and `ReplayKernel` (fold a recorded Trace).

**The local coding agent (landed):** the memory kernel's acceptance capstone is a real coding agent running locally — `test/AI/CodingAgent.test.ts` plus `test/AI/fixtures/coding/toolbox.ts` (four capability contracts — `readFile`/`writeFile`/`grep`/`bash` — with `localToolbox(root)` physics over `FileSystem`/`Path`/`ChildProcess`, sandboxed to a temp workspace, every operational error a model-visible tool failure). The `FixTests` bounded loop diagnoses a genuinely failing `bun test` suite, greps/reads to find the bug, rewrites the source (never the tests), re-runs the suite, and exits via halt-as-tool; the test verifies out of band that the suite passes, the source changed, and the specification files are byte-identical. This is the standing template for coding-agent work until the Cloudflare harness lands: same charter, swap `localToolbox` for DevBox layers.

### 2.7 Durability & persistence (normative contract)

Consolidates §2.3 (event schema), §2.4 (durability doctrine), §3.2 (the Durability ladder), §9.3/§9.5 (survey findings), and the Eve mapping's stash-point protocol (`reports/effect-ai-mapping-eve.md` §4.1) into one answer to *"batch, per-event, or pluggable?"*

**The backend is pluggable; the protocol is not.** `Durability`/`TraceStore` is a harness seam — a `Context.Tag` the Kernel interface never mentions, with a ladder of Layers (`memory` dev → `doFiber` DO storage → `workflow` → `think` interop). But *what* is written, *when*, and with *what atomicity* is a normative contract every Layer must implement, enforced by the conformance suite. Every surveyed system that let persistence policy vary with the backend (rather than just the storage medium) paid for it in divergent recovery semantics.

**The unit of durability is the stash point, not the event and not a timer.** Durable events are appended *individually* — append-only rows, per-ring `seq`, deterministic ids from `(term, session, turn, callId/ordinal)`, versioned envelopes from v1 — but commits are **transactional at command boundaries**:

```
stash point  =  ONE transaction:
  1. Trace append — the epoch's durable events
     (ModelRequested/Completed with Usage, ToolRequested/Completed/Failed)
  2. StepState checkpoint — { v, promptHash, seq, phase, budget ledger,
     transcript (Prompt codec, system message EXCLUDED — re-rendered from
     the term), pendingAsk? }
```

The batch boundary is *semantic*: it sits exactly where the write-ahead ordering requires it, never on a timer or a count. That ordering is the crash-correctness property itself:

- `CallModel` is journaled **before** the wire call; `CallTool` **before** execution; results after. Recovery therefore re-runs *at most one* model call and repairs half-settled tool batches through the pairing invariant (synthetic `aborted` results — repair-on-read already composes with this).
- Timer/count batching is **rejected** because it can reorder "persist intent" after "external effect happened" — at which point a crash forgets an effect the world already saw. Rows are truth, wakes are hints; a row must exist before the world can observe its effect.
- On Durable Objects this discipline is nearly free: within one invocation, storage writes coalesce and the **output gate** holds outgoing I/O until writes confirm — per-event `put`s inside a stash point are effectively one platform batch anyway. The memory kernel gets the same semantics with an in-memory array + a synchronous "transaction".

**What is never persisted:** live deltas (`text-delta`, `tool-params-delta`) — `durable: false`, no `seq`, excluded from folds, may drop on disconnect. The durable/live split is type-level (§2.3); a delta cannot advance a cursor by construction.

**Recovery tiers (§9.3, revised doctrine):**

- **Floor — resume + repair (conformance-gated):** load the last stash, fail orphaned in-flight work as typed interruptions, deliver the last fold, route through the `Resume` policy (`Continue | Retry | Terminal`). Checkpoint fossils: a stash carries the `promptHash` it was created under; mismatch with the deployed term routes to policy (default `Retry` with fresh render), never blind `Continue`.
- **Stretch — deterministic replay (`ReplayKernel`, Workflow-tier):** the pure step machine + deterministic ids make byte-exact replay *possible* (replayed emissions collide idempotently on id), but no surveyed system ships it for half-finished turns and none needed it to be reliable. It is not the gate for `AI.Kernel.memory`.

**Two-plane state (never a second transcript):** plane 1 = mutable coordination (admission ledger — idempotent by delivery id, FIFO runnable head, attempt markers, leases); plane 2 = the append-only Trace + fold stash. "A run is active" is *derivable* from the planes; no durable run object is ever resurrected. The `Prompt` handed to the model is always *derived* (fold → repair → render), never stored as an independent source of truth — `Chat`'s snapshot persistence is explicitly not used as a store (§ build-order conflict 3).

**Memory-kernel implication (next small pieces):** implement `TraceStore.memory` (array + seq counter) and route the ring's emissions through it — this simultaneously un-stubs `kernel.events`/`kernel.trace` and gives the conformance suite its first two subjects (`memory` now, `doFiber` in Phase 3).

### 2.8 Agent-to-agent communication (sync, async, spawn, check-in)

There is no new channel here — the §2.5 constitution stands (upward: return value, events, typed errors; sideways: through the world only; never a private cross-ring pipe). Agent-to-agent communication is a *model-visible surface* over the `ProcessService` verbs we already have: `dispatch` **is** synchronous communication (admit + join), `send` **is** asynchronous (admit alone), and everything else composes.

**The four patterns, most to least structured:**

1. **Call (sync — landed).** The delegation tool's handler is the delegate's `dispatch`: the caller's turn blocks on the `CallTool` command until the delegate's ring resolves; the distilled result (subagent-summary pattern) is the tool result. Agent-as-function. Right when the parent has nothing better to do than wait.
2. **Fan-out/collect (structured — no term, by prior decision).** Map-reduce over items is `Effect.forEach` + `concurrency` around pattern 1, barrier at the end. A pipeline without feedback is not a loop; it gets no vocabulary.
3. **Spawn-and-continue (async — the new surface).** Composition, not invention:
   - **`spawn`** = `send` on the delegate's ring **+** a completion route: when the child run halts, its terminal Trace event (which already carries `cause` = the parent's spawn command id) is delivered to the parent as a **steer** — "run `Engineer#42` completed: «distilled result»" — promoted at the parent's next model-call boundary like any other steer. This is the Mastra amendment (*background results arrive as steers*) realized: the parent never polls and never blocks; a result is a renewed mandate at a boundary. If the parent's run has already ended, the completion steer **parks** and enters its next run — the parked-steer semantics land this for free.
   - **Check-in** = a pure read: a `check_runs` synthetic tool whose handler reads the child ring's Trace / admission ledger (status is *derived from rows* — `run.iteration`, `turn.halted` — never a wake). This is `AI.observe` semantics applied to children: observation resets no keepalive.
   - **Join** = a `wait_for(runKey)` tool that parks the parent until the correlated completion arrives — which is the **Ask protocol with a run key instead of a human**. Waiting on a subagent and waiting on a person are the same protocol: same durable park row, same answer correlation, same amendment machinery. Build the park once (build-order item 6); get both.
4. **Standing collaboration (peers).** Loops that talk through the world: one ring's tool side effects produce the EventSource stimuli that trigger another. Org-topology level; needs the trigger runtime, not communication machinery.

**Decisions:**

- **Sync vs async is the caller's per-call choice, not charter wiring.** The charter declares *who* may be delegated to (`${Engineer}` — capability by interpolation); whether one call blocks or backgrounds is the model's decision — a `background: boolean` param on the delegation tool (the Task-tool shape the survey validated). A control ref like `AI.async(Engineer)` would wire a runtime mood into the type system — wrong layer.
- **Run identity is addressable.** `spawn` returns the child's run key (`(term, work item)` — the session key we already mint; in the DO harness, the child's admission-ledger row id). `check_runs` / `wait_for` / completion steers all correlate on it; `cause` provenance already stamps every event with the parent command.
- **Interruption cascades down (the gap spawn exposes).** Scope authority: interrupting a parent run must interrupt its spawned children. Today even *sync* delegation violates this — the caller awaits a `Deferred` while the delegate runs on its own ring, so interrupting the caller orphans the delegate mid-burn. Fix: each run keeps a durable child registry (`cause`-linked rows); `interrupt` fans out as control admissions to child rings. This is §9's "durable cancel of parked work" hard problem made concrete — spawn is what makes it urgent, and the ledger (build-order item 5) is its substrate.
- **Budgets lease, never net** (already resolved, Eve conflict #2): spawn reserves the child's grant against the parent's remainder at fork time, reconciles on settlement. Async fan-out is exactly why netting over-grants.
- **The child's Trace is the parent's audit surface.** No transcript ever crosses rings — check-in and completion steers carry distilled rows, and a parent wanting more detail gets an `AI.observe`-style read grant, not the transcript.

**Build order within this section:** (a) ✅ completion-steers + `background` param on delegation tools + `check_runs` — landed in the memory kernel: background dispatches fork into the interpretation Scope (release the Layer, pending spawns die), the settled distilled result steers the host (`Background run Sage#bg0 completed: …`, parking if the host is idle so the *next* run's round 1 carries it), and `check_runs` is a pure registry read; live-tested end to end (spawn → immediate `spawned` reply → delegate runs the real tool in the background → steered result answers turn 2). Anthropic footnote: optional tool params must be `Schema.optionalKey` — `Schema.optional`'s `| undefined` AST is rejected by structured outputs. (b) ✅ the child registry + interrupt cascade — landed in the memory kernel: rings expose an *internal* cancellable admission (a symbol-keyed kernel-to-kernel surface, absent from `ProcessService`; custom Layers degrade gracefully), delegations register their child admission with the host for the lifetime of the join, and `interrupt` cancels children first — a queued admission tombstones without ever running a turn (its reply settles as `Interrupted`), the active one gets a control admission on its own ring (safe on shared delegates: serial ring ⇒ active = *this* item). In-flight tool executions are now raced against a per-turn interrupt signal, so a parent blocked on a slow child (or any hung tool) settles it as an aborted, model-visible result immediately — the fiber is interrupted, the transcript stays paired. Live-tested: cancelling the Chief frees a Mathematician stuck in a 60s tool hang in seconds, with the delegate's own Trace recording `Interrupted`. (Durable, run-key-addressed cancel across process restarts remains the ledger's job in Phase 3.) Testing footnote: hang-and-cancel tests must use `it.live` — `it.effect`'s TestClock freezes `Effect.sleep`/`Schedule.spaced` and fakes a deadlock. (c) ☐ `wait_for` (with the Ask protocol, item 6); (d) ☐ peer topologies (with triggers, item 7's remainder).

#### Phase 2 build order (synthesized from the effect/ai mapping reports)

Seven reports (`designs/ai/reports/effect-ai.md` + `effect-ai-mapping-{pi-flue,ai-sdk,codex,opencode,mastra,eve}.md`, every API verified against the installed `.d.ts`/`.js`) converged on the substrate verdict — **effect/ai is safe to bet on**: it is strictly a turn library (one model round per call; no loop to fight), `Tool.dynamic`/`Toolkit.make` support runtime per-term assembly, `Usage` carries cache splits (USD budgets computable), streaming is id-keyed blocks, and every reason OpenCode abandoned the AI SDK is covered by the v4 providers or by our control inversion. The keystone everywhere: **`disableToolCallResolution: true`** — the kernel owns tool execution at command level.

Conflicts resolved across reports:

1. **Approval protocol (OpenCode's G1 landmine wins).** effect/ai's approval pre-resolution executes approved tools *even with resolution disabled*, and its `needsApproval` evaluation fails open. Rule: kernel-compiled tools never set `needsApproval`, and prompts never carry approval parts (`AI.lint` rule + the pairing repair strips them defensively). Our durable Ask owns the park/answer lifecycle in the ledger + Trace; model-visible denials render as ordinary failed tool results with reasons.
2. **Budget leases reserve, not net** (Eve mapping): outstanding child grants are reserved against the parent's remainder at fork time and reconciled on settlement — netting only completed children over-grants under concurrent fan-out.
3. **`Chat` is not a store.** Its `Ref<Prompt>` + snapshot persistence is a second transcript by construction; the Trace is truth, the `Prompt` is derived (fold → repair → render). `Prompt`'s Schema codec is still the serialization vehicle for `StepState`'s transcript slice.

Known gaps we own (full lists in the reports): model catalog (context windows for compaction thresholds), token estimation, price table + unknown-usage policy, approval signing, sticky streams (recovery = resume+repair, never stream-resume), `ResponseIdTracker` identity doesn't survive Trace rebuilds (persist the `ModelResponseId` bookmark), Anthropic assistant-block cache anchors (provider TODO). Upstream PR candidates: raw finish reason; `needsApproval` with `R` param. Dependency note: the v4 provider packages (`@effect/ai-anthropic`, `-openai`) are npm `beta` dist-tags peer-pinned to the exact effect beta.

The order (each step independently testable; 1–3 are pure, no provider needed). Status markers track `src/AI/` as of July 2026 — every ✅ is covered by both a scripted test (`KernelMemory.test.ts` / `Step.test.ts`) and a live Anthropic acceptance test (`KernelLive.test.ts`, skip-gated on `ANTHROPIC_API_KEY`):

1. ✅ **`Ids.ts`** — `commandId(session, stepIndex, ordinal)` / `eventId(cause, kind)` derivation + a deterministic per-turn `IdGenerator.Service` (replay-stable even for provider-gap-filled ids).
2. ✅ **`Pairing.ts`** — repair-on-read over `Prompt.Message`: synthetic failed results for orphaned calls (deterministic by construction — effect/ai results key on call id only), orphan-result drops, approval-part stripping (G1), provider-executed exemption. Property tests: well-paired, idempotent, deterministic, trim-composing.
3. ✅ **Step machine (`Step.ts`)** — `Command`/`Feedback` with ids; truncated-batch rule (`finish.reason === "length"` + tool calls ⇒ fail wholesale); `StepState` survives `structuredClone`. Landed beyond the plan: transactional token accounting with declared `unknownUsage`, `Steered` boundary promotion, `Interrupt` batch settlement (real results kept, rest aborted, `abandoned` on the outcome), transcript seeding for iterated (loop) turns. Not yet: the StreamPart → KernelEvent *total* mapping (the kernel maps the four load-bearing part kinds; reasoning/source/file parts pass through unmapped).
4. ✅ **Stage-B turn driver (memory kernel, `KernelMemory.ts`)** — `streamText` + `disableToolCallResolution`; write-ahead emission through the `TraceStore` seam (§2.7: `model.requested` before the wire, `tool.requested` before execution, terminals with `Usage`; `model.delta` live-only); transactional budget decrement off `FinishPart.usage` with ceilings from the `KernelPolicy` `Context.Reference`. Not yet: RW-lock tool scheduler (tools run serially in call order), `ToolInterceptor`.
5. ◐ **Admission ledger + Coordinator reduction** — the memory ring is landed: one `forkScoped` serial loop per process term over an unbounded mailbox, `dispatch = send + join` (reply seats via `Deferred`), `steer` as admission (mid-turn inbox / idle park / halt-race re-park), `interrupt` as control admission. Not yet: durable ledger rows, join/coalesce-wake reduction, delivery-id idempotence.
6. ☐ **Ask protocol** — payload/answer/amendment schemas; park = durable row; answers via the ledger; `PolicyAmended` fold state; `SteerError` union on `steer`.
7. ◐ **Stage-C loop runtime** — dispatch-driven bounded loops are landed: `interpret(Loop)` compiles the charter + halt prose, **halt-as-tool** (`resolve` with JSON-string-wrapped value validated strictly in the kernel handler — wire-lenient so schema-invalid resolves bounce as tool errors for self-correction; `give_up` → typed `Refused`), iterated turns with the transcript-carry fold, boundary nag, charter `AI.budget` iterations/tokens → typed `BudgetExceeded`, and a default iteration guard for budget-less loops (defect, not typed exit). Perpetual charters (`AI.never`/no halt) are rejected with `KernelError` until triggers land. Not yet: trigger streams feeding `run()`, `AI.check`/`AI.fold` agents at the boundary, N-consecutive `Refused` ratification, idle-wake continuation, `prompts/` kernel assets with `kernelAssetsHash`.
8. ☐ **`ContextPolicy` seam** — placement-owning contract; `truncate` default (pair-atomic, prompt-preserving); Anthropic server-side context management as a free second policy.
9. ☐ **`ApproveGuardian` layer** — `generateObject` judge, fail-closed timeout, denial circuit breaker.
10. ☐ **`CloudflareAgent.test.ts`** — the Ring DO grown from mock to Phase-2-backed: admit → dispatch → turn with a gated tool → park/answer-with-amendment → steer semantics → halt ordered after the plane-2 commit → trace replay to an identical fold → evict-and-recover with fossil check.

---

## 3. Phase 3 — The Cloudflare harness

### 3.1 Shape

```ts
// packages/alchemy/src/Cloudflare/AI/Harness.ts
export const Harness: Layer.Layer<
  AI.Kernel,
  never,
  | AiLanguageModel                          // provider — user's choice
  | Cloudflare.DurableObjectState            // the hosting DO (ring state)
  | Cloudflare.Workflows.Binding             // iteration-scale durability
  | Cloudflare.Queues.Binding                // `each` work queues
> = Layer.effect(AI.Kernel, Effect.gen(function* () { ... }))
```

The user selects it exactly like any Alchemy layer — `Layer.provide(Cloudflare.AI.Harness)` — and satisfies its `R` by composing standard Alchemy Cloudflare resources (`Cloudflare.DurableObject`, `Cloudflare.Workflows.Workflow`, `Cloudflare.Queues.Queue`, `Cloudflare.Containers`). A user who wants a different engine writes their own `Layer.effect(AI.Kernel, ...)` against the same tag and the same conformance suite. **The Kernel tag is the only shared interface; every component below this line is private to this Layer.**

The Ring DO's persisted state is **two planes, never a second transcript** (§9.3, from Flue and OpenCode v2):

1. **Coordination plane** — the mutable admission ledger: every stimulus (work item, steer, cancel, budget edit) enters through *one ordered, idempotent inbox* keyed by delivery id (GitHub's delivery id, a deterministic dispatch key), with per-ring FIFO runnable-head, attempt markers, and *advisory* leases (DOs are single-threaded; a Node harness would need real heartbeat leases). There is no second control plane — a cancel is a stimulus like any other, which is what makes durable cancellation tractable (Eve failed to ship it five times through a separate hook layer).
2. **Truth plane** — the append-only Trace (per-ring `seq`) plus the fold, committed in the same transaction as the events that motivated it. Fold snapshots record their `promptHash` so recovery detects checkpoint fossils after a redeploy. "A run is active" is *derivable* from these planes; no durable run object is ever resurrected.

Wakes are hints, rows are truth: triggers/alarms set an edge-triggered dirty signal and the reducer re-reads the ledger, so missed or duplicated wakes are harmless.

**Landed sketch:** `test/AI/fixtures/org/cloudflare/` mocks this whole shape end to end and *type-checks against the real Cloudflare + GitHub modules*:

- `kernel.ts` — a `Ring` Durable Object (one instance per ring; storage holds the two planes: `admit` is idempotent by delivery id, `trace(after)` is the cursored read, `fold()` carries the checkpoint with its `promptHash`) and `CloudflareKernelLive: Layer<AI.Kernel>` built over the Ring namespace, implementing `events`/`trace` and routing `dispatch`/`steer`/`interrupt` through the one inbox. Bodies are `TODO(Phase 2)` dies; the plumbing (DO namespace resolution, per-ring routing, idempotent admission) is real.
- `events.ts` — `GitHubEventsLive` provides the org's `GitHubEvents` channel over `GitHub.consumeRepositoryEvents`, so the deployment *provisions the repository webhooks* via `GitHubRepositoryEventSourceLive` (the existing `src/Cloudflare/Workers/GitHubRepositoryEventSource.ts` chain); verified deliveries are admitted into ring DOs keyed by GitHub's delivery id (redeliveries collapse).
- `tools.ts` — per-contract physics as plain `Layer.succeed`s, including the two-`Bash` demonstration (`BashDevBox` read-write for the Engineer; `BashReadOnly` for the Judge — Phase 3 upgrades the Judge to a **copy-on-write overlay** sandbox: the verifier executes anything, effects don't escape; refusing `rm` by regex means the Judge can't run tests).
- `worker.ts` — the composed org: per-agent layers with their own tool provisioning, ring layers over agent layers, channels and kernel provided last, all onto one `Cloudflare.Worker` hosting the Ring DO namespace, with a typed `POST /issues/:n/fix → fix.dispatch(issue): Effect<PullRequestRef, BudgetExceeded | Refused>` route proving the graph closes.

### 3.2 Internal seams (services of the harness, unknown to the Kernel)

Each is a `Context.Tag` exported from `Cloudflare.AI`, pulled by the harness with a default, overridable by `Layer.provide` onto the harness layer:

```ts
Cloudflare.AI.Durability      // journal / stash / recover / resume-policy
Cloudflare.AI.TraceStore      // event log: DO SQLite hot, R2 cold
Cloudflare.AI.ContextPolicy   // default: truncate (pair-atomic, prompt-preserving);
                              // optional: OM (buffered activation), tiered
Cloudflare.AI.Sandbox         // Containers-backed exec, Scoped acquire/release;
                              // optional capabilities (snapshot, expiry) are
                              // separate optional tags probed via serviceOption;
                              // owns its own hibernation watchdog (activity =
                              // tool calls / fs changes — NEVER observation)
Cloudflare.AI.ToolInterceptor // sees every CallTool before execution; may block
                              // (synthesizing the result per the pairing
                              // invariant) or rewrite — the "what policies
                              // apply" layer under the "who decides" tool
                              // Layers; pass-through default
Cloudflare.AI.WorkQueue       // `each` semantics over Queues + the Ring DO's
                              // idempotent admission ledger (ordering,
                              // coalescing, and burst behavior are specified —
                              // stronger than any surveyed system ships)
Cloudflare.AI.Router          // EventSource name → ring trigger routing
```

This is inversion (4) in practice: "Sandbox", "Memory", "Compaction" are not framework concepts — they are implementation details of one harness, discoverable only by reading which tags its `Layer.effect` pulls. ContextPolicy's contract includes *placement* (where summaries and re-injected context go — model-trained, provider-coupled lore) not just *what to drop*; the fold pipeline order is normative: `fold → render → markCacheBoundaries → CallModel`. Note also what our architecture dissolves: the rendered term is re-supplied from the immutable term on every model call and sits outside ContextPolicy's jurisdiction — guardrails cannot be compacted away because they were never in the compactable region (the surveyed harnesses need re-injection hooks for exactly this).

#### Durability (the ladder)

Duty-cycle analysis dictates three physics, all behind one seam:

| Granularity | Mechanism | Used for |
|---|---|---|
| Ring (perpetual `AI.never` loops) | **DO reducer**: event-sourced `(state, stimulus) → [state', spawns]`, state in DO SQLite, wake-decide-sleep in ms | `Flywheel`, `Helpdesk` — awake ~0.01% of the time; no resident fiber, no 15-min limit ever approached |
| Iteration / work item | **Cloudflare Workflow instance** per `Fix#1234`: each iteration = `step.do`, human waits = `step.waitForEvent` (days, free), cron rings = Workflow cron; **the persisted step result is the folded state** — compaction and crash-recovery are the same operation | `Fix` runs, `Autoresearch` weekly runs |
| Turn (streaming, chat-latency) | **doFiber**: Think-style write-ahead journal in DO SQLite — journal the `Command` before executing, stash folded `StepState` after, on boot deliver checkpoint to a typed `Resume` policy `(cp) => Continue \| Retry \| Terminal` | interactive agent turns; mid-stream eviction recovery |

```ts
export class Durability extends Context.Tag("cf/ai/Durability")<Durability, {
  journal: (cmd: Command)   => Effect<void>
  stash:   (s: StepState)   => Effect<void>
  recover:                     Effect<Option<Checkpoint>>
}>() {}
export class Resume extends Context.Tag("cf/ai/Resume")<
  Resume, (cp: Checkpoint) => Effect<Continue | Retry | Terminal>
>() {}
```

Because the Phase 2 step machine keeps `StepState` serializable by construction (live resources come from Scoped Layers, never from state), `stash` is trivial and recovery is: re-provide the environment, resume the pure state. Provide four Layers: `Durability.memory` (dev), `Durability.doFiber`, `Durability.workflow`, and `Durability.think` (thin interop over `@cloudflare/think`'s `runFiber`/`stash`/`onFiberRecovered` for teams who want Cloudflare's battle-tested recovery; ours remains the default because the journal must be our Trace format and portable off-Cloudflare). Evaluate backing `@effect/workflow`'s engine with CF Workflows as a shared substrate — if it fits, that engine is an independently valuable OSS artifact.

Replay constraint (restated because it is the one way to lose): everything between Activities must be deterministic. Model calls, tool calls, and container exec are Activities/steps; folds and `step` are pure. Enforce by construction: folds execute in a context providing neither `Clock` nor `Random`.

#### Triggers → physics

| Term | Cloudflare mechanism |
|---|---|
| `AI.on(Github.*)`, `AI.on(Discord.*)` | Webhook → Worker route → `Router` → ring DO stimulus (Queues-buffered for burst) |
| `AI.on(KernelEvent)` (parent watching child) | internal bus: DO → Queues/RPC to subscribing ring DO |
| `AI.each(param)` | Queue + DO-side dedupe/ack ledger |
| `AI.every(cron)` | DO alarm (per-ring) or Workflow cron (per-run) |

A ring's charter compiles to **routes**, not to a resident `Stream.merge`. `LoopHandle.run` on this harness registers routes and returns; "running" means "reachable".

#### Human-backed tools

`ApproveHuman` / `AskHumanDiscord` Layers implement their tool contract as `step.waitForEvent(...)` (Workflow scale) or DO-alarm-guarded pending rows (reducer scale), with typed timeouts escalating as `KernelEvent`s. Same tool tag as the dev-mode console prompt; the autonomy dial never touches charters.

#### Memory Layers

`ContextPolicy.truncate` (default) · `ContextPolicy.tiered` (Claude-Code-style graduated: result-budget caps → snip → summarize) · `Cloudflare.AI.ObservationalMemory` — Observer/Reflector as fold-time agent invocations, observations in ring-DO SQLite, thresholds configurable, cache-stable two-block rendering. OM's mechanics map one-to-one onto the fold seam; this Layer is the flagship demo of "memory strategy as one-line topology change."

**Phase 3 deliverables:** `Harness` layer passing the Phase 2 conformance suite; `Durability` (memory/doFiber/workflow, think-interop stub); ring-DO reducer runtime + `Router`; Queues-backed `WorkQueue`; `Sandbox` over Containers (Scoped); GitHub + Discord `EventSource` providers (webhook ingestion resources in Alchemy proper); `TraceStore` (SQLite hot / R2 cold) + OTel exporter (bridges to the existing observability backend work); `ObservationalMemory` layer; chaos tests: kill DOs mid-turn, mid-fold, mid-wait; replay-divergence detector in CI.

---

## 4. Phase 4 — The reference organization on Cloudflare

The dogfood target: the org whose job is to build Alchemy. Repos: `alchemy-effect` + siblings. Surfaces: GitHub issues/PRs, Discord. Rings: Helpdesk (support), Flywheel (product), Fix (task), Autoresearch (system). Oversight: this file.

### 4.1 Terms (`src/org/*.ts`)

Vocabulary and tools as in §1.7, plus:

```ts
export class Support extends AI.Agent<Support>()("Support")`
You are Alchemy's support engineer on Discord — the first
human-facing surface of this organization.

1. ${SearchIssues} for duplicates and workarounds first.
2. Reproduce with ${Bash} in a clean DevBox when plausible;
   ${ReadFile} docs to distinguish bug from documentation gap.
3. Real bug → ${CreateIssue} with your repro attached, then
   ${Reply} with the link. Docs gap → ${CreateIssue} labeled docs.
4. ${AskHuman} for anything touching secrets, state corruption,
   or billing — never speculate publicly about those.
You never promise timelines. You never say "should work."` {}

export class Triage extends AI.Agent<Triage>()("Triage")`
For each new ${issue}: dedupe via ${SearchIssues}; label
bug|feature|docs|question; write acceptance criteria as a
checklist verifiable by a command or test. Label "ready" only
when criteria are complete — a ready issue is a spec; own it.` {}

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer")`
You review PRs against their originating ${issue} — the diff and
the spec, nothing else; you did not see the reasoning, and that
is the point. Verdict via ${Approve} or changes via ${Reply}.` {}

export class Scribe extends AI.Agent<Scribe>()("Scribe")`
You are the organization's memory. Distill traces into durable
artifacts: failed approaches → .alchemy/NOTES.md (dated, terse);
recurring confusions → docs issues via ${CreateIssue}. You
compress; you never narrate.` {}
```

```ts
export class Flywheel extends AI.Loop<Flywheel>()("Flywheel")`
The development flywheel for alchemy-run repos.

${AI.on(Github.IssueOpened({ org: "alchemy-run" }))} run ${Triage}.

${AI.on(Github.IssueLabeled({ org: "alchemy-run", label: "ready" }))}
dispatch a ${Fix} run — at most ${AI.concurrency(3)} in flight,
smallest estimates first.

${AI.on(Github.PullRequestOpened({ org: "alchemy-run" }))} assign
${Reviewer}; a rejected review reopens the originating ${Fix} with
the review attached as new acceptance criteria.

${AI.on(Github.Push({ branch: "main", titlePrefix: "chore(release):" }))}
hand off to ${ReleaseBlogger}.

${AI.never`no exit; merge rate, time-to-first-response, and reopen
rate are folded weekly and posted via ${Reply} to #maintainers`}` {}

export class Helpdesk extends AI.Loop<Helpdesk>()("Helpdesk")`
${AI.on(Discord.ThreadCreated({ channel: "#help" }))} run ${Support}.
${AI.on(Discord.Mention({ user: "@alchemy" }))} run ${Support}.
${AI.fold(Scribe)`weekly: cluster threads; the top recurring
confusion becomes a docs issue, filed with evidence`}
${AI.never`support does not halt while the product lives`}` {}

export class Autoresearch extends AI.Loop<Autoresearch>()("Autoresearch")`
${AI.every("1 week")} study the traces of ${Flywheel} and
${Helpdesk}: cluster failures; find prompts correlated with
reopened issues; find tools agents misuse or avoid.

Propose improvements as PRs against src/org/ — edits to agent
templates, new tools, changed Layer wiring. Every proposal must
cite the traces that motivated it and include an eval that would
have caught the failure. You may ${AskHuman} to understand intent.

${AI.until`a maintainer closes the experiment`}` {}
// note the absent ${Approve}: the system ring cannot be granted
// merge authority by any Layer — enforced by Req, not prose.
```

Coupling audit: `Helpdesk → Flywheel` exists only because `Support` holds `${CreateIssue}` and `Flywheel` triggers on `IssueOpened`. Every inter-ring hop crosses GitHub or Discord — durable, auditable, human-readable. Deleting a ring stops its mail; it breaks nothing.

### 4.2 Physics (`src/org/topology.ts`)

```ts
// sandbox
export class DevBox extends Cloudflare.Container<DevBox, DevBoxApi>()("DevBox") {}
const Sandbox = Cloudflare.Containers.layer(DevBox, { enableInternet: true })

// tool physics
const CommonTools = Layer.mergeAll(
  SearchIssuesLive, CreateIssueLive, ReplyLive,   // Github/Discord clients
  BashDevBox, FsDevBox, GrepDevBox,               // sandboxed exec
  AskHumanDiscord,                                // #maintainers, 24h timeout
).pipe(Layer.provideMerge(Sandbox))

// the autonomy dial — per ring, two provides apart:
export const FixLive = AI.layer(Fix).pipe(
  Layer.provide(ApproveAuto),          // ring 2: the test suite approves
  Layer.provide(CommonTools))
export const FlywheelLive = AI.layer(Flywheel).pipe(
  Layer.provide(FixLive),
  Layer.provide(ApproveHuman),         // ring 3: a human merges
  Layer.provide(CommonTools))
export const HelpdeskLive = AI.layer(Helpdesk).pipe(Layer.provide(CommonTools))
export const AutoresearchLive = AI.layer(Autoresearch).pipe(
  Layer.provide(CommonTools))          // deliberately no Approve to give
```

### 4.3 Deployment (`org.alchemy.run.ts`)

```ts
// per-ring reducers: one DO class, instance per ring
export class Ring extends Cloudflare.DurableObject<Ring>()(
  "Ring",
  Effect.gen(function* () {
    const kernel = yield* AI.Kernel
    return { stimulus: (e) => kernel.route(e) }      // wake-decide-sleep
  }).pipe(Effect.provide(
    Cloudflare.AI.Harness.pipe(
      Layer.provide(Layer.mergeAll(
        FlywheelLive, HelpdeskLive, AutoresearchLive)),
      Layer.provide(Anthropic.layer({ model: "claude-sonnet-4-6" })),
      Layer.provide(Cloudflare.AI.ObservationalMemory),   // optional seam
    ))),
) {}

// iteration engine: Fix runs as Workflow instances
export const FixWorkflow = Cloudflare.Workflows.Workflow("Fix",
  Cloudflare.AI.workflowOf(FixLive))

// ingress: webhooks → Router → ring stimuli
export default Cloudflare.Worker("Org", { main: import.meta.url },
  Effect.gen(function* () {
    const rings = yield* Ring
    yield* Github.consumeOrganizationEvents({ org: "alchemy-run" },
      Cloudflare.AI.route(rings))
    yield* Discord.consumeGuildEvents({ guild: "alchemy" },
      Cloudflare.AI.route(rings))
  }))
```

One `alchemy deploy` provisions: the Worker, the Ring DO namespace, the Fix Workflow, the work Queue, the DevBox Containers, R2 for cold traces, the GitHub/Discord webhook registrations — and starts the organization. Editing a template and redeploying is a ring-5 act; `promptHash` diffs appear in the PR.

### 4.4 Acceptance walkthrough (the flywheel, end to end)

```
Discord #help thread
  → Ring(Helpdesk) DO wakes → Support agent turn (doFiber)
  → CreateIssue ────────────────────────── GitHub
  → webhook: IssueOpened → Ring(Flywheel) → Triage → labeled ready
  → webhook: IssueLabeled → spawn Workflow Fix#N
       ⟳ iterations: Engineer, fresh context; step.do per iteration;
         fold → NOTES.md; halt when Bash reports green
  → PR opened → webhook → Reviewer → Approve
       (ApproveHuman: step.waitForEvent, ≤7 days)
  → merge → Push(chore(release):) → ReleaseBlogger → blog post
  → weekly alarm → Autoresearch reads Trace → PR against src/org/
```

Phase 4 ships when this trace executes on production Cloudflare with a human approving exactly one step, and every hop is visible in the Trace/OTel view.

---

## 5. Build plan

**Phase 0 — Spikes (1–2 weeks).** (a) ~~Nested-template ref inference~~ — done: depth-1 nesting confirmed fast and legible against the reference org. (b) ~~`RequireHalt` encoding~~ — spiked and **rejected**; the missing halt is a type (`Out = never`), not a constructor error (§1.5). (c) Renderer semantics frozen (inline vs sectioned control refs; ref-to-text rules; `promptHash`) — outstanding. (d) `@effect/workflow`-on-CF-Workflows feasibility read — outstanding. Exit: written decisions; throwaway code.

**Phase 1 — Terms (2–3 weeks).** §1 deliverables. Exit: the §4.1 org type-checks; renderer golden files reviewed; omitting a halt or a provided tool fails compilation with a message a newcomer understands.

**Phase 2 — Kernel + memory harness (3–5 weeks).** §2 deliverables. Exit: `ReleaseBlogger` answers over `AI.Kernel.memory` under `alchemy dev`; a toy `Fix` loop runs against a local git repo with Ralph semantics; conformance + property suites green; `ReplayKernel` reproduces a recorded session byte-for-byte.

**Phase 3 — Cloudflare harness (4–6 weeks).** §3 deliverables. Exit: conformance suite green on CF; chaos suite (evictions mid-turn/mid-fold/mid-wait) recovers per `Resume` policy; a `Fix` Workflow survives a redeploy mid-run; OM layer demo: one-line swap changes memory strategy on a live ring.

**Phase 4 — Reference org + observability (3–4 weeks).** §4 deliverables, Trace→OTel export wired to the observability backend, weekly Autoresearch producing its first trace-cited PR. Exit: §4.4 walkthrough on production; org runs one real week unattended except ring-3/5 approvals.

**Deferred (explicitly not now):** multi-org federation; non-Cloudflare harnesses (AWS) beyond keeping `Durability`/`memory` portable; `param.as` overrides if Phase 0 defers them; dynamic (agent-authored) charters via Dynamic Workflows — powerful, but ring-4 output should stay *PRs against static terms* until evals mature; a visual topology viewer (derivable later from terms + Trace).

## 6. Risks & open questions

| Risk | Mitigation |
|---|---|
| Nested-ref inference blows up tsc or yields unreadable errors | Phase 0 spike; cap nesting depth at 1; fall back to sectioned (non-nested) control refs if needed |
| Replay divergence from impure folds | No `Clock`/`Random` in fold context; CI replay-divergence detector; conformance test |
| Prompt-cache instability vs. rendered-template churn | Renderer stability rules; tool contracts render into schema section, not prose; `promptHash` regression check in CI |
| Trace volume/cost at ring scale | SQLite hot / R2 cold tiering; per-event sampling class; DDSketch-style aggregates for health signals (reuse observability work) |
| Human-wait timeouts creating zombie work items | Typed timeout → `Escalated` event → parent policy; Workflow `waitForEvent` timeouts mandatory |
| Autoresearch reward-hacking its own evals | Ring 4 has no `Approve` by construction; proposals must ship an eval; human merge gate is structural |
| Think/CF API drift for the interop layer | Interop is optional; native `doFiber` is default; pin `@cloudflare/think` versions |
| Shared-parameter description mismatch across tools | `param.as\`…\`` derived parameters (Phase 0 decision) |
| Durable cancel of parked work (Eve failed 5×) | Cancel is a stimulus through the same ordered inbox — no second control plane; a cancellation is never classified retryable; conformance-tested |
| Fold blind spots (non-text content) create unrecoverable rings | The fold owns the full content model: oversized/binary results replaced with previews + drillback refs before entering StepState |
| Review-bandwidth exhaustion (Krieger's bottleneck) | Human attention is a budgeted resource; `Ask` Layers rate-limit; ratchet-by-amendment reduces repeat asks |
| Unvalidated graders enforce the wrong standard, fast | Judge model ≠ doer model (lint); default judge prompts version-tested via `promptHash`; check-failed parks, never re-loops |
| Stale sandbox handles / state divergence after DO eviction | Provider state is truth, DO rows are caches; probe handles (cheap read-only exec) before resuming a Bash-bearing turn |
| Budget enforcement under unknown usage | Usage counts are `number \| undefined` in the wild; declared per-ring policy (fail-closed default) |
| Per-provider token counting is unscoped harness work | Adopt model-aware tokenizers behind a seam; counts cached per message |

## 7. Glossary

**Term** — pure-data declaration; the broad word for every node of the language, split into three classes (§1). **Process term** — `Agent` or `Loop`: the only interpretable kinds; each denotes a Process `In → Run<Out, Err>` and interprets into a `ProcessService` with its own ring. **Capability term** — `Tool` or `Parameter`: compiled into a host process's toolkit, never interpreted, no ring. **Control ref** — `Trigger`/`Halt`/`Fold`/`Check`/`Budget`/`Concurrency`/`Observe`: parameters of a process term's ring. **Ref** — an interpolated value in a term's template; the unit of dependency. **Charter** — a Loop's template. **Ring** — a loop at some organizational scale; operationally, the single serial mailbox-drain loop a process term interprets into (one ring per process-term Layer). **Check** — the positional verifier: an agent assigned to grade the halt condition at the iteration boundary; the maker/checker split applied to the stop condition. **Fold** — the boundary compression of an iteration's Trace into carried state; the unit of memory and of durability. **Trace** — the persisted `KernelEvent` log; single source for memory, replay, observability, and autoresearch. **Kernel** — the `Context.Tag` whose implementations interpret terms. **Harness** — a Kernel implementation Layer plus its private component services. **Seam** — a `Context.Tag` internal to a harness (Durability, ContextPolicy, Sandbox…), invisible to the Kernel interface. **Autonomy dial** — the choice of Layer implementing human-class tools per ring. **Oversight loop** — the humans editing this repository.

## 8. Loop design research (July 2026 survey)

A deep-dive across the "loop engineering" literature that exploded in June–July 2026, conducted to pressure-test our representation before Phase 2. Three research threads: (a) the loop taxonomy and its surrounding essays, (b) software factories (product loops) as actually built, (c) task loops (Ralph) and system loops (autoresearch) as actually run. Sources verified by fetch where possible; unverifiable claims are flagged rather than repeated.

### 8.1 Provenance corrections

- The taxonomy article (Appendix A below) was **written by Laurie Voss** (Arize DevRel, npm co-founder) and distributed by Aparna Dhinakaran as an X Article (Jul 4, 2026, 1.1M views). Canonical copy: `seldo.com/posts/what-the-hell-is-a-loop-anyway/`. §0.1's attribution to "Arize / Dhinakaran" should read Arize / Voss.
- The four loop names are **Voss's labels for what swyx drew**; "oversight loop" is Voss's coinage for the ring swyx's Loopcraft keynote diagram literally labeled "????". swyx's own thesis (latent.space/p/loopcraft, Jun 12): *"the entire game of the next century is to be able to stack loops as effectively as possible… valuable to know when to go DOWN a loop when things go wrong (for reliability)… more valuable to know how to go UP a loop as models improve (for leverage)."*
- Osmani's "inner loop is capability, outer loop is agency" is from his **AIEWF stage remarks**, not the Loop Engineering essay (the essay's framing is harness-vs-loop). Both are his; cite accordingly.
- Geoffrey Litt's "factories are a depressing vision" is a tweet + talk; his fuller argument is the Jul 2 essay *Understanding is the new bottleneck* (geoffreylitt.com).

### 8.2 The three diagrams, extracted

The primary diagrams (swyx's Loopcraft stack; Voss's taxonomy table; Voss's loop stack with exits named). Transcribed here because the architecture they describe is the most concentrated statement of what our representation must express.

#### (a) swyx's Loopcraft stack — mechanism-indexed

Header progression: **Tokens → Turns → Tasks → Teams** (turns = "the agent loop"). Five nested rings, each a `(verbs, exit, timescale)` triple:

| # | Ring | Verbs (iteration body) | Exit | Timescale |
|---|---|---|---|---|
| 1 | token loop | sample, append, repeat | stop token | ≈ seconds |
| 2 | agent turn | call tool, feed result | no more tool calls | ≈ minutes |
| 3 | /goal loop | run, **judge**, retry | goal reached | ≈ hours |
| 4 | MetaLoop — the loop that makes loops | spawn, review, respawn | collaboration and competition | ≈ days |
| 5 | ???? loop | set goals, allocate, cull | none. open exploration | ∞ |

The illustrated ring bodies matter as much as the labels. Ring 2's body is environment feedback made concrete (`read_file()` → 240 lines; `run_tests()` → 3 passed). Ring 3's body is `agent result → judge: off-goal ✗ → agent result → judge: goal met ✓` — **the judge is drawn inside the ring, between agent runs, and the exit belongs to the judge, not the agent**. Ring 4's verbs (spawn, review, respawn) are lifecycle authority over inner rings; ring 5's (set goals, allocate, cull) are the oversight verbs Voss later named.

#### (b) Voss's taxonomy table — scale-indexed

| Loop | What iterates | Closing signal | Human role | Timescale | Canonical example |
|---|---|---|---|---|---|
| Execution | Steps within one task | Tool results, environment feedback | At the boundaries | Minutes | Any agent session |
| Task | One artifact against one spec | Tests, spec compliance | Writes the spec, judges done | Hours | Huntley's Ralph Loop |
| Product | A codebase and its backlog | Issues, logs, user feedback, review outcomes | Configurable checkpoints | Continuous | Warp's Oz, Factory |
| System | The system itself | Evals, judges, filtered feedback | Tacit knowledge source, escalation point | Days to weeks | Introspection, Karpathy's autoresearch |

#### (c) Voss's loop stack, exits filled in ("after swyx's Loopcraft stack")

| Ring | Completes | Exit |
|---|---|---|
| Execution loop | an instruction | no more tool calls |
| Task loop | a spec | spec satisfied, tests pass |
| Product loop | the product | **none, by design** |
| System loop | (improves the whole system) | evals and judges say better |
| Oversight loop | — "you should live here" | **yours to call** |

#### What the diagrams teach, structurally

1. **Two orthogonal indexings of one stack.** swyx indexes by *mechanism* (token/turn/goal/meta), Voss by *scale* (execution/task/product/system). They don't align one-to-one: swyx's MetaLoop ("spawn, review, respawn") spans Voss's product *and* system loops — spawning task loops is the product ring's job, respawning-after-review shades into the system ring. Our single `Loop` grammar with channels derived from refs is agnostic to both indexings, which is right: the representation shouldn't privilege one decomposition.
2. **A ring is a `(verbs, exit, timescale)` triple.** Verbs live in our charter prose; the exit is the typed halt; the timescale is *derivable* (from triggers and budgets) rather than declared — worth keeping that way, since a declared timescale would just be a comment.
3. **Exit kinds ascend from mechanical to judgmental**: stop token → the model's own decision → environment verification → eval judgment → human judgment. Each ring exists because it *distrusts the exit of the ring below* — ring 3 wraps ring 2 precisely because "no more tool calls" ≠ done. This is the cleanest justification yet for `Out` being derived from the halt: what a ring means is what ends it.
4. **The judge is positional** (ring 3's body). Like our fold, it is a role in the loop runtime, not a capability of the working agent. Strongest corroboration yet for the verifier-position refinement flagged in §8.4 — swyx draws what we suspected we were missing.
5. **Perpetuity is declared, not accidental.** "Exit: none, by design" is a named, legitimate contract — exactly `AI.never` with health signals substituting for an exit. And "exit: yours to call" confirms the top ring's exit is a human, unwired on purpose.
6. **Outer rings hold lifecycle authority over inner rings** — spawn, review, respawn, cull. Our claim §0.6 (authority flows down via fiber/Scope; interruption and budgets propagate down) is the Effect-native encoding of these verbs. "Cull" is fiber interruption; "respawn" is re-dispatch with the review attached (which the Flywheel sketch already does: a rejected review reopens the originating Fix run).
7. **The human role is a per-ring position**, not a global dial: boundaries → spec author + done-judge → configurable checkpoints → tacit-knowledge source + escalation point → resident. Our encoding: `Approve`/`AskHuman` as ordinary tools whose Layer is chosen per ring, the charter prose as the spec, and the oversight ring as the source file. All four positions are expressible; none is mandated.

#### Ring-by-ring mapping to our terms

| Ring | Our representation | Exit encoding |
|---|---|---|
| Token loop | not represented — inside the model | — |
| Execution loop / agent turn | `Agent` term; the act–observe cycle is Kernel-internal and deliberately has **no halt term** | kernel policy (turn ends on no more tool calls) |
| Task loop / `/goal` | `Loop` + `AI.each(param)` + `AI.until(schema)` + `AI.fold` + `AI.budget` — the `Fix` sketch | `Out = Schema["Type"]`, `Err = BudgetExceeded` |
| Product loop / MetaLoop | `Loop` + `AI.on(events)` + `AI.never` + `AI.concurrency`, dispatching `${Fix}` — the `Flywheel` sketch | `Out = never`; health signals in the `never` prose |
| System loop | `Loop` + `AI.every(cron)` + `AI.observe(rings)` + `AI.until`, no `Approve` in `Req` — the `Autoresearch` sketch | `Out` from the halt; merge gate structural (absence of ref) |
| Oversight loop | not a term — the source file, code review, `alchemy deploy` | "yours to call" |

Two gaps the diagrams sharpen beyond §8.4's list: (a) the positional judge (point 4 above); (b) MetaLoop's exit "collaboration and competition" implies *comparative* evaluation among concurrently spawned runs — culling by selection. `AI.concurrency(3)` says how many are in flight; nothing yet names the selection/culling policy ("smallest estimates first" lives only in the Flywheel prose). Likely kernel policy + charter prose, but now documented.

### 8.3 The primary sources, one load-bearing idea each

| Source | The idea we must not lose |
|---|---|
| Voss/Arize, *What the hell is a loop, anyway?* (Jul 4) | The rings are **different types** — different closing signals, different tooling, different evals. One recursive construct is the wrong shape. |
| swyx, *Loopcraft* (Jun 12 + AIEWF keynote) | Going UP/DOWN the stack must be cheap. The top ring's contract is deliberately open ("????"). Orchestration — goals, spawning, culling — is the durable skill. |
| Osmani, *Loop Engineering* (Jun 7) | A loop needs five things + memory: automations (trigger), worktrees (isolation), skills (externalized knowledge), connectors (capabilities), sub-agents (maker/checker) — and durable state: *"The state file is the spine of the whole thing… The agent forgets, the repo doesnt."* The verifier must be structurally separate from the doer: *"the maker and checker split applied to the stop condition itself."* |
| LangChain, *The Art of Loop Engineering* (Jun 16) | Four stacked loops (agent / verification / event-driven / hill-climbing) where the fourth's return arrow *"doesn't just loop back to the top — it reaches inside and updates the agent loop directly."* Outer loops rewrite inner loop **definitions**. Graders are typed components, deterministic or agentic. |
| Huntley, *Ralph* (Jul 2025) + *everything is a ralph loop* (Jan 2026) | `while :; do cat PROMPT.md \| agent; done`. One task per loop. Fresh context; state lives in the repo. **Backpressure**: anything can be wired in to reject invalid generation (tests, analyzers, scanners), but *"the wheel has got to turn fast"* — validation gets exactly one subagent. *"Completion lives outside the model."* Human = locomotive engineer: watch the loop, fix each failure so it never recurs. CTRL+C-gated stepping *"is still ralphing"* — autonomy is a dial on an invariant shape. |
| Gavrilescu (Introspection), Latent Space (Jul 1) | *"The inner loop is the primary system… the outer loop studies and maintains the primary system."* The **recipe**: a provenance-carrying record of how each signal produced a new judge or change — *"The code alone would not necessarily be that helpful if you could not see how the team arrived at the current version."* `ask-a-human` as a typed tool whose usage declines like a new employee's questions. *"Build orchestras before factories… design the human as a core component."* |
| Karpathy, *autoresearch* (Mar 2026) | Three files, one permission boundary: `prepare.py` is *"the immutable evaluation harness — the agent cannot touch it"*; `train.py` is the only agent-writable file; `program.md` is the human strategy. Fixed 5-minute budget per experiment makes results comparable. Keep rates 10–18% — the loop's job is discarding hypotheses cheaply. |
| Meta, *Brain2Qwerty v2* (Jun 2026) | Guardrails **in code, not prose**: append-only tracker, improvement recorded only on strict WER decrease, tracker hardcoded to validation data only, held-out cross-subject eval run once after all rounds. Three agents in isolated worktrees, no cross-branch reads. And the caveat: *"final configuration selected by the research team"*; open-ended objectives **failed** — agents idle or entangle the codebase. |
| Warp/Oz (Lloyd, Jun–Jul 2026) | The seven-stage lifecycle: **triage → specification → implementation → review → verification → shipping → monitoring**. Two loops: event-triggered inner loop ships software; schedule-triggered outer loop reviews past runs and PRs changes to the *skill files that drive the inner-loop agents* — *"Humans decide what improves; agents propose it."* Every human intervention is recorded telemetry the improvement loop consumes. The autonomy KPI is automatic-merge rate, ratcheted 20%→60%. |
| Factory.ai (Jun 2026) | Signals from **outside the codebase** are first-class inputs (bug reports, conversations, incidents). *"Monitoring that deployed software generates more signals. The entire system is a continuous feedback loop."* Autonomy tiers: task → recurring automation w/ shared memory → persistent execution → multi-day mission. Stages independently adoptable and instrumentable. |
| Anthropic (Krieger, AIEWF; harness engineering posts) | Delegation unit is a **standing responsibility**: *"Don't just fix this bug. Now you are responsible for this part of the codebase, and I want you to monitor this feedback channel and proactively take on tasks."* Bottleneck: *"bottlenecked on reviews"* and *"human ability to fully conceptualize what we're doing."* Test ratchet: agents may not remove or weaken tests. Fresh-context resets were a mitigation for Sonnet 4.5's "context anxiety" — Opus 4.5 dropped them; **the externalized fold is the durable requirement, the reset is tunable.** |
| Horthy (HumanLayer), 12-factor agents + AIEWF debate | *"Kubernetes is built on control loops. But they're deterministic loops."* Factor 8: the while-loop, retries, timeouts, and exit condition *"belong in your code, not buried in the model's behavior."* Factor 12: agent = stateless reducer over an event list. Factor 6: pause/resume with a serializable token. Small loops (3–10 steps) don't drift. |
| Litt, *Understanding is the new bottleneck* (Jul 2) | *"It's never just one loop!… the understanding you have of the system is part of your ability to come up with the next idea."* Cognitive debt. The comprehension quiz as a **speed regulator**: *"it's easy for the loop to run faster than the speed of human understanding."* |
| Bakaus (AIEWF) | *"There is no auto, and there will be no auto."* Some human checkpoints are **structural** (taste, authorship, ownership), not confidence-gated scaffolding to ratchet away. |
| LangWatch, *Loop engineering is a measurement problem* | The shadow stack: for every loop that does work there's a measurement responsibility. *"There's a sentence hiding in the middle of every loop diagram — 'and then we check whether it worked' — and that sentence is doing enormous load-bearing work."* *"A loop you can't measure isn't a feedback loop. It's a fast way to be wrong on a schedule."* |

### 8.4 Consolidated requirements, mapped to our representation

Grouped by which of our term channels carries the requirement. ✅ = the current representation expresses it; ⚠️ = expressible but undesigned; ❌ = gap.

**Halt / `Out` channel**

- ✅ Typed exit signal per ring, differing in kind (environment feedback / spec satisfaction / perpetual-with-health-signals / human judgment). `AI.until`, `AI.until(schema)`, `AI.never` cover the taxonomy; `Out = never` for unhalted charters is exactly Effect's meaning. [Voss; LangChain; Ng's three-loop cadence letter]
- ✅ Bounded-by-machine and bounded-by-human are the same type — a maintainer closing an experiment arrives as an event, like `${Bash}` reporting green. [Huntley's CTRL+C; Gavrilescu]
- ✅ *(adopted)* **Exit is a prioritized disjunction, not a scalar**: success-by-verifier / budget-exhausted / stagnation-detected / escalated-to-human. Our `Err` carries `BudgetExceeded`, whose `limit` now includes `"stall"` — the no-progress ceiling (`AI.budget({ …, stall: 3 })`) joins the hard limits, so the Masood/Horthy triad (success predicate + ceiling + no-progress) is fully typed. Stagnation *detection* (repetition, oscillation, diminishing delta) is kernel policy; the ceiling makes it a typed exit. Escalation vocabulary (`blocked` / `needs-info` / `park` — Warp's triage states) remains undesigned; revisit with the kernel's escalation path.
- ✅ *(adopted)* **The verifier must be structurally separate from the doer and outside the loop's write scope.** Osmani's maker/checker on the stop condition itself; Karpathy's immutable `prepare.py`; Meta's hardcoded val-only tracker; Anthropic's test ratchet; swyx's positional judge (§8.2). Now a term: `AI.check(Judge)\`…\`` assigns an agent the verifier role at the iteration boundary, `Fold`-shaped (agent + optional per-ring template + nested refs → `Req`). The capability separation is expressed by the Judge's own toolbox (run/read, never edit); write-scope isolation of the verifier is a Phase 2 kernel obligation.

**Trigger / `In` channel**

- ✅ The settled trigger taxonomy — event (`AI.on`), queue/parameter (`AI.each`), cadence (`AI.every`) — matches LangChain's event-driven loops, Warp's webhook-vs-schedule split (inner loop event-triggered, improvement loop schedule-triggered), and Osmani's automations ("the heartbeat… what make a loop an actual loop and not just one run you did once").
- ✅ Signals from outside the codebase as first-class inputs: `EventSource` is world-side by design. [Factory.ai; Tížková]
- ⚠️ **Signal filtering/prioritization**: not every event should wake the outer ring; Gavrilescu's first advice is "invest in your signals." Trigger predicates/prioritization are unmodeled — probably kernel policy, but the charter prose may need a typed place to name the filter.
- ❌ **Ambient/absence triggers**: Krieger's standing-responsibility delegation and Claude Tag's "follow up on stalled tasks" fire on *lack* of progress, not on an event. No current constructor expresses "when X has been silent for N days." Defer, but record it.

**Fold / memory**

- ✅ The fold spans both directions — compress-into-state (Mastra OM) and deliberately-carry-nothing (Ralph, memory in artifacts) — already §0.1's position, now strongly corroborated: Anthropic dropped context resets for Opus 4.5, proving the **externalized fold is the durable requirement and the reset a tunable mitigation**.
- ✅ Fold as durability checkpoint = Horthy's Factor 12 stateless reducer + Factor 6 pause/resume token, and Anthropic's `wake(sessionId)` reconstitution.
- ⚠️ **Partitioned write permissions on externalized state**: Ralph's discipline is typed in practice — specs human-owned, plan agent-writable, operational memory agent-appendable-but-bounded, tests add-or-strengthen-only (the ratchet). Our `Fold` names the folding agent and instructions but not what it may write to. Kernel concern for now; the charter prose carries the policy.
- ❌ **Provenance-carrying fold (the "recipe")**: Gavrilescu's strongest structural claim — the record of *why* each change happened (signal → judge → change lineage) is the asset, diffable and attributable. Our Trace (§2) is the natural carrier; the design should state explicitly that fold snapshots reference the trace events that motivated them.

**Budget / `Err` channel**

- ✅ Typed budgets producing `BudgetExceeded` in `Err`. Cost control is universally non-negotiable [Gavrilescu's "unexpected thousand-dollar bill"; Amplify survey: 40% regularly cost-limited; Pstrucha: "you can't orchestrate your problems away by buying more tokens"].
- ⚠️ **Per-iteration budgets are semantic, not just protective**: Karpathy's fixed 5-minute training runs make experiments comparable; Meta's "exactly 50 jobs per round" is a shape constraint. Our `AI.budget` is per-loop. Consider whether iteration-scoped limits belong in the term or the kernel.
- ⚠️ **Judging itself has a budget**: per-round LLM judging can dominate cost (semantic-early-stopping finding); the outer ring's *deliberation* tokens need bounding too [Gavrilescu]. Expressible today by budgeting the ring; worth a design note.
- ✅ **Human review bandwidth is a budget**: Krieger's bottleneck, Osmani's "orchestration tax" ("YOU are still the ceiling"). Our model already prices this correctly — human-class tools are ordinary capabilities whose Layers can rate-limit — but §6 should list review-bandwidth exhaustion as a first-class failure mode.

**Req / capabilities / authority**

- ✅ **Capability denial by absence-of-ref is the load-bearing guarantee** and the research keeps validating it: Meta's no-merge-authority, Warp's "humans decide what improves; agents propose it", our ring-4-has-no-`Approve` invariant (§6). The Amplify survey's "nobody has settled the control layer for agents; top safeguards are approvals and permissions" is precisely the gap a typed `Req` fills.
- ✅ `AI.observe` — trace access without capability inheritance — is the typed version of LangChain's "traces are the input of the hill-climbing loop" without granting the hill-climber the inner loop's tools.
- ✅ `ask-a-human` as an ordinary Tool in `Req` [Gavrilescu, verbatim: "The human can effectively become a tool and a source of signals"], with the orchestra→factory dial being which Layer implements it — our claim §0.9, confirmed.
- ⚠️ **Outer loops rewriting inner loop definitions**: LangChain's "reaches inside", Warp's skill-file PRs. Our stance (system-loop output = PRs against the org's own typed source, review-gated) is the conservative end of this spectrum and the research supports keeping it: Meta's open-ended agents failed; Warp gates skill changes behind normal PR review. No change; cite the evidence in §6.
- ⚠️ **Isolation between concurrent runs**: Meta's disjoint worktrees / no cross-branch reads, Osmani's worktrees, Ralph's single-writer monolith. `AI.concurrency(3)` says how many; nothing says how isolated. Kernel/harness concern (sandbox seam), but the requirement is now documented.

**Observability**

- ✅ Trace as the single source for memory, replay, observability, and autoresearch (§2) is the strongest cross-source convergence: Huntley's "watch the loop", Gavrilescu's git-as-audit-log, LangWatch's shadow stack, Warp's recorded-intervention telemetry. LangWatch names our design's justification: *"a loop you can't measure isn't a feedback loop."*
- ❌ **Human-legible explanation artifacts**: Litt's participation argument wants each iteration to emit an explanation a human can learn from, not just an auditable diff — and his quiz-as-speed-regulator suggests a comprehension gate as a checkpoint type. Not Phase 1; noted for the human-tools palette (alongside `Approve`/`AskHuman`).

### 8.5 What the research does NOT support

- **A fan-out primitive.** Voss argues dispatch/gather/validate is a pipeline, not a loop; Masood independently: "Fan-out and fan-in is map-reduce… fan-in requires barrier synchronization", not a closing signal. Cognition's Agentic MapReduce is real and useful, but it is Effect's existing concurrency vocabulary (`Effect.forEach` + `concurrency`) inside a loop body, not a term kind. Our decision to give fan-out no primitive stands.
- **A uniform recursive loop construct.** Every source differentiates the rings by exit-signal kind, state type, and timescale (Ng: agent seconds–minutes / developer minutes–hours / world hours–weeks). Our single `Loop` grammar with *channel types derived from refs* is the right compromise: one constructor, indexed structure.
- **Hardcoding the top ring.** swyx left it "????" on purpose; Voss reserves it for humans; LangChain instead injects humans per-level. The literature genuinely disagrees, so our representation must stay agnostic — which it is: the oversight loop is the source file (§0.10), and per-ring human checkpoints are Layer choices on human-class tools. Both camps expressible, neither mandated.

### 8.6 Genuine disagreements in the literature (and our stance)

1. **Who runs the outer ring?** Gavrilescu puts agents in it; Osmani says it stays human ("inner loop is capability, outer loop is agency"). *Ours:* configurable per ring via Layers; the system ring's structural no-`Approve` is the safety floor either way.
2. **Is fully-auto the destination?** Huntley (level-9 evolutionary factories) vs. Bakaus ("there is no auto") vs. Gavrilescu (build toward it, human as core component). *Ours:* both checkpoint kinds must be expressible — confidence-gated (ratchetable away) and structural (a loop with no fully-auto exit path). The second kind is today only convention; consider whether a halt that *names a human signal* should be distinguishable in the type.
3. **Monolith vs. multi-agent.** Huntley's "red hot mess" vs. Meta's three isolated explorers and Horthy's micro-agent DAGs. *Ours:* both shapes are charters; isolation discipline (disjoint write scopes) is what makes the second safe, and that lives in the harness.
4. **Fresh context: law or mitigation?** Ralph says essential; Anthropic dropped it for Opus 4.5. *Ours:* already settled correctly — the fold interface spans both, `fold = const(spec)` is Ralph.
5. **Judges everywhere or at gates?** StreamZero wants mid-flight judges; the semantic-early-stopping result shows per-round judging can dominate cost. *Ours:* judge placement is kernel policy; the term names the signals, the harness decides cadence.

### 8.7 Actions taken / to take on the design

- §0.1's taxonomy bullet: correct attribution to Voss; keep the adopted corrections (indexed rings, exit-signal-defined, "naming ≠ wiring", no fan-out primitive, autonomy dial per ring) — all now independently sourced. ✅ done.
- §1 (terms): two refinements adopted and implemented after review of the diagrams (§8.2): (a) **`AI.check(Judge)`** — the positional verifier, a `Fold`-shaped control ref assigning an agent the judge role at the iteration boundary (maker/checker applied to the stop condition; swyx draws it inside the /goal ring); (b) **`stall` as a budget ceiling** — the no-progress detector joins the hard limits, surfacing as `BudgetExceeded` with `limit: "stall"` (the Masood/Horthy "three exits" triad: success predicate + ceiling + no-progress, with the latter two both in `Err`). Escalation vocabulary (`blocked`/`needs-info`/`park`) remains undesigned — revisit when the kernel's escalation path is built.
- §2 (kernel): add to its obligations — verifier-outside-write-scope enforcement, test-ratchet-style fold monotonicity constraints, stagnation detection, per-iteration budget envelopes, pause/resume tokens (already implied by fold-as-checkpoint), provenance links from fold snapshots to motivating trace events.
- §6 (risks): add review-bandwidth exhaustion (Krieger's bottleneck) and unvalidated graders ("a loop that enforces the wrong standard, fast" — LangWatch) as named risks.

---

## 9. Harness archaeology (July 2026 survey)

Eight production systems studied at source level (one research agent each; full reports with `file:line` evidence in [`designs/ai/reports/`](./reports/); repos vendored under `.vendor/`). The goal: pressure-test the Kernel interface, step machine, fold, and Cloudflare harness design against everything the industry has already paid to learn.

### 9.1 The subjects, one load-bearing lesson each

| System | What it is | The lesson we must not lose |
|---|---|---|
| **Mastra** | class/config agent framework; loop = a workflow on its own durable engine | The agent loop *as* a workflow validates our Phase 3 plan wholesale. Five stacked continuation mechanisms mutating one `isContinued` flag is what happens when halt policy has no positional home. Goal-step verdict precedence: judge-failure **parks with a reason, never silently re-loops**; budget exhaustion parks with a resume hint, not a tombstone. |
| **OpenCode v2** | Effect-native rewrite of a shipped coding agent | Event-sourced sessions (projectors inside the append transaction, seq-cursor replay+tail), durable admission inbox (`steer` vs `queue`), Context Epochs, a 104-line `Coordinator` (join / coalesce-wake / interrupt), permission replies of allow / decline / **correct-with-feedback**. Two-stream discipline: durable replayable events vs live-only deltas, never unified. |
| **Codex** | OpenAI's Rust CLI/engine | SQ/EQ protocol; **repair-on-read tool pairing** with deterministic cache-stable synthetic IDs; approvals as **policy amendments** ("don't ask again for this pattern"); the Guardian (LLM judge at the approval gate, fail-closed, human appellate); `/goal` = idle-wake restart + evidence-audit exit + 3-strikes `Blocked`; no deterministic replay — resume + normalize, at massive scale. |
| **Flue** | pi-loop wrapped in a durable substrate on CF DOs / Node | Two-plane state: mutable submission ledger (CAS claims, attempt markers, per-session FIFO, advisory leases on DOs) vs append-only conversation log with **delta-granularity journaling and deterministic record ids**. Recovery classification enumerated (`resume` / `tool_results_partial` / `tool_use_unresolved` / …); `finish`/`give_up` result tools — **`give_up` is a typed refusal our `Err` cannot yet express**. Channels verify ingress but never provision the wire. |
| **Pi** | the minimal harness itself | The 9-hook seam checklist; steering/follow-up queues with precise delivery points (after current turn's tools / at would-stop); compaction as pure preparation → replace-or-defer → durable entry with provenance (`firstKeptEntryId`); session = append-only *tree* with branch-summaries as folds; the fold must own the full content model (image-blind compaction bricked sessions). |
| **AI SDK** | the industry's provider abstraction + tool loop | `LanguageModelV4` after three spec revisions: id-keyed block streaming, **unified + raw** duals (finish reason, usage), escape hatches at every granularity, **cache-token splits without which `usd` budgets are unenforceable**. `stopWhen` is our halt untyped — `result.output` *throws* when stopped via tool call; our `Out`-from-halt makes that a compile error. Approval-as-message-parts with HMAC signing; the workflow slice loop solves mid-block stream recovery. |
| **Eve** | Vercel's filesystem-first durable agents | Step results as the persistence boundary (fold-as-checkpoint validated; they persist raw history and pay for it). One park protocol for approvals/questions/OAuth/budget-continuation/subagent-completion. Budget leases down the delegation tree (children split the parent's *remainder*; spend debits up). **Cancellation of parked durable work failed to land five times** — a named hard problem. Versioned envelopes + migrators on every durable shape. |
| **Vercel Academy (TeensyCode)** | v0 team's distilled harness course | 31 named production gotchas: the `needsApproval` confabulation trap (a blocked tool call with no result → the model invents success); bounded-output-as-prevention with a three-part truncation contract; prune-then-cache ordering; sandbox state machine + activity-tracker bugs; snapshot fossils; COW-overlay as the correct verifier physics (refusing `rm` by regex means the Judge can't run tests). |

### 9.2 Convergent validations (independent systems arriving at our claims)

1. **One event log as the single representation** (§2.3): Codex rollouts = wire = telemetry; OpenCode EventV2; Flue's canonical stream; AI SDK's v7 tracing-channel refactor (inline OTel reverted after three majors). Universally converged.
2. **Terms as pure data**: OpenCode agents are Schema structs, modes are permission rulesets; Codex subagent roles are config layers. Our typed-term version is the strong form.
3. **Maker/checker retrofitted everywhere it was missing**: Mastra's networks shipped LLM self-assessed completion, admitted it hallucinates, and retrofitted external-validation scorers + a goal judge with read-only tools and its own thread. `AI.check` is positionally correct from day one.
4. **Subagents are composition, not a kernel feature** (§2.4): all eight. Child = child session/thread/ring; results return distilled; recursion denied by construction or blocklist.
5. **Memory/compaction as private seams**: pi's replaceable preparation, Mastra's processors, AI SDK's `prepareStep` + userland. Nobody puts memory in the kernel interface. Codex's mid-turn summary-placement lore (model-trained position sensitivity) proves *why*: it's provider-coupled and would poison a public interface.
6. **Nobody provisions the wire.** Flue verifies webhooks but the user creates them; Eve attaches via `vercel connect` out-of-band; Mastra provisions Slack imperatively at runtime. `EventSource<In, Channel>` → `Req` → Layer → provisioned Webhook resource remains genuinely unoccupied territory (§1.2.3's claim survives contact with all eight).

### 9.3 Decisions adopted into the design (the flow-through)

**Trace (§2.3), amended:**
- **Two streams, two contracts.** `Kernel.events` (live, no replay guarantee — deltas, UI) and `Kernel.trace(ring, after?)` (durable, per-ring sequence cursor, replay-then-tail). Deltas are typed non-durable and can never advance the cursor. [OpenCode; AI SDK restricted dispatcher]
- **Versioned, identified events.** `KernelEvent` carries a schema version from v1 (OpenCode reset beta history twice for lack of it; Eve migrates every durable envelope). Durability-relevant events have **deterministic ids** derived from `(term, session, turn, callId/ordinal)` — never minted at emit time — so replay collides idempotently. [Flue; Codex cache-stable synthetic ids]
- **Provenance grows `cause` and `auth`.** Every event: `{ring, term(promptHash), session, workItem, cause (parent command id / trigger ref), auth {initiator, current}}`. Cause-less seam events forced pi users to monkey-patch; auth provenance is what makes caller-sensitive approval policies one predicate. [pi #5217; Eve]
- **Emission ordering is normative**: `ToolRequested` before any gate; blocked/denied is a distinct terminal event from failed (autoresearch's most informative signal is the denial). [Academy; Warp]
- **Wake physics**: rows are truth, wakes are hints — edge-triggered capacity-1 dirty signal per ring; readers re-query the log. [OpenCode]

**Step machine (§2.4), amended:**
- **Tool-pairing invariant, broadened and mechanized.** Every `CallTool` command is answered by exactly one `ToolResult` feedback — including **policy blocks** (a blocked call synthesizes a real result the model sees; the confabulation trap is worse than execution), **interruption** (typed "interrupted" results; never silently re-execute), and **truncated-arguments** (a `length`-truncated call batch fails wholesale — salvage-parsed JSON that validates may be incomplete). Enforced as **repair-on-read**: a pure normalization pass over Trace-derived messages with deterministic synthetic fills, composing with any fold/trim. Provider-executed deferred results are a *typed exemption*. [Academy; Codex; pi; AI SDK]
- **New feedbacks: `Steered` and a specified `Recovered`.** Steering = mid-run input delivered at the iteration boundary (never mid-turn), queue semantics owned by the harness, promotion resets the step allowance. `Recovered` carries Flue's classification verbatim: reuse durable partials; repair unresolved tool calls as interrupted-errors; re-dispatch the model at most once when nothing persisted. [pi; OpenCode; Mastra signals; Flue]
- **Budget accounting is per-command and transactional.** Every `CallModel`/`CallTool` feedback updates budget state; ceilings can fire between any two commands. Decrements commit in the same transaction as the fold/Trace write — never aggregated after the fact. Usage follows the AI SDK v4 shape (cache-read/write/uncached splits, all `number | undefined`) with a declared policy for unknown usage. [pi #4325; Codex; AI SDK]
- **Purity checklist:** no id generation, no `Date.now()`, no perf timing inside `step` — ids arrive in feedback or derive from `(session, stepIndex, ordinal)`; timestamps live on interpreter-written events; **nothing in `StepState` closes over a function** (schemas included). [AI SDK workflow pain; Mastra RunScope pain]
- **Model choice is per-turn data, not construction-time config.** `CallModel` carries the model resolved at interpretation time (kernel default ← ring policy ← agent Layer override), so Judge-on-cheap-model and mid-run switches need no recomposition; cross-model continuation strips provider-native metadata. [pi; Mastra `ModelByInputTokens`; OpenCode; Academy]

**Durability doctrine (§2.4/§3.2), revised:**
- **Resume + repair is the conformance floor; deterministic replay is the stretch tier.** Codex, OpenCode v2, Flue, and Eve all ship persist-facts/repair-on-recovery and explicitly refuse silent side-effect replay; none deterministically replay a half-finished turn. The pure step machine stays (testability, model-free simulation), but the default Ring `Resume` policy is: fail orphaned in-flight work as typed interruptions, deliver the last fold, require explicit `Continue | Retry | Terminal`. Byte-exact `ReplayKernel` remains the Workflow-tier stretch goal, not the gate for `AI.Kernel.memory`. [all four; resolves the §2.4 tension]
- **Checkpoint fossils**: recovered state carries the `promptHash` it was created under; mismatch with the deployed term routes to policy (default `Retry` with fresh render), never blind `Continue`. [Academy snapshot-fossils; Eve durable/rebuilt split]
- **Two-plane Ring DO state**: plane 1 = mutable coordination (admission ledger: idempotent by delivery id, per-ring FIFO runnable head, attempt markers, advisory leases — DOs are single-threaded); plane 2 = the append-only Trace + fold. Never a second transcript. [Flue; OpenCode]

**Halt / Err (§1.2.2), amended:**
- **`Refused` joins `BudgetExceeded`.** A bounded loop can conclude `Out` is unachievable — Flue's `give_up`, Codex's evidence-gated `Blocked` (repeat-observed blocker, N consecutive iterations). Typed, distinct from budget exhaustion, derived for `until`-halted loops. Implemented in `src/AI/Errors.ts` + `LoopErr`.
- **Halt-as-tool is the cheapest correct `until` implementation**: a synthetic `resolve` tool whose input schema is the halt schema; the model calls it, the check grades it; schema-invalid calls bounce back as tool errors for self-correction; a turn ending with neither `resolve` nor `give_up` gets a bounded nag. [Flue result tools; AI SDK `hasToolCall`; Codex `update_goal`]
- **Check verdicts are four-valued**: goal-met / off-goal(feedback) / **waiting** (stop-but-stay-active; ask the human — the §8.4 escalation vocabulary) / **check-failed** (judge errored → park with reason, never silently re-loop). [Mastra goal step]
- **Budget exhaustion parks, resumably**: `BudgetExceeded` carries `{limit, used, resumeHint}`; the ring retains fold + work item so re-dispatch after a budget raise continues. Interactive rings may surface it as a continuation `Ask`. [Mastra; Eve]

**Ask / HITL (§2.4/§3.2), generalized:**
- **`Ask` = "park durably until a correlated answer arrives"**, with approval, question (2–4 structured options), OAuth, and budget-continuation as payload kinds; one protocol, one event pair. Unrelated input during a pending ask is held, never treated as denial. [Eve; Academy]
- **Answers are verdict + optional amendment**: an approval can carry a durable policy delta ("approved for session", "never ask for this pattern", network rule) persisted as fold-visible ring state — the autonomy dial ratchets by use, with the ratchet history in the Trace. Third verb: **correct-with-feedback** (typed feedback re-enters the loop). Declines are typed `denied` results the model sees; escalation-halt is a separate non-model-visible control signal. [Codex; OpenCode]
- **Answer authenticity is first-class**: asks are signed, answers verified (our answers arrive over world surfaces — Discord, GitHub). [AI SDK HMAC]
- **Ask Layers are channel-paired**: the Layer implementing `Ask` for a ring renders onto (and accepts answers from) the surface whose EventSource triggered the run. [Eve]
- **The Guardian pattern** is a Layer, not a term: an LLM judge implementing `Approve` (fail-closed, timeout → escalate, deny-circuit-breaker, human override) sits between `ApproveAuto` and `ApproveHuman`. [Codex]

**Subagents / ForkLoop (§2.4), amended:**
- Child rings are durably parent-linked by the forking event id; parent-scope death settles the fork as typed interruption while retaining the child Trace; child budgets are **leases** split from the parent's remainder, reconciled on completion; at the depth cap, delegation tools are de-advertised before hard-blocked; background completion re-enters as an ordinary trigger. Fork-of-trace (child born with a Trace-prefix reference) is a third memory topology alongside OM-fold and Ralph-fresh — noted, deferred. [Flue; Eve; OpenCode task tool; Codex fork modes]

**Sandbox seam (§3.2), amended:**
- The Judge's physics are a **copy-on-write overlay**, not command refusal — the verifier executes anything; effects don't escape. Optional capabilities (`snapshot`, `expiresAt`) are separate optional seam tags probed via `Effect.serviceOption`, not widened core interfaces. The hibernation watchdog is the Sandbox Layer's own durable loop; **observation never counts as activity** (`AI.observe` reads are pure storage reads — neither wake nor keepalive). Provider state is truth; DO rows are caches — probe handles after recovery. Per-iteration sandbox scoping (fresh sandbox per Ralph iteration) must be expressible as a Scoped-per-iteration Layer. [Academy; AI SDK]
- **New harness seam: `ToolInterceptor`** — a private tag (pass-through default) that sees every `CallTool` before execution and may block (synthesizing the result per the pairing invariant) or rewrite; the "what policies apply" layer under the "who decides" tool Layers. [Academy two-layer approval; Codex orchestrator]

### 9.4 Named hard problems (added to §6 risks)

- **Durable cancel of parked work** — Eve failed five times; every failure in the trigger/cross-process layer. Cancel must be a stimulus through the same ordered inbox as everything else (no second control plane); a cancellation is never classified as retryable.
- **Fold blind spots**: a fold that only owns text makes image/attachment-heavy rings unrecoverable (pi's infinite re-compaction loop). The fold owns the full content model, including preview-and-drillback replacement of oversized results.
- **Review-bandwidth exhaustion** and **unvalidated graders** (from §8) joined by: **stale sandbox handles after DO eviction**; **token counting per provider** as unscoped harness work; **budget enforcement under unknown usage**.

### 9.5 What we deliberately did not adopt

- **Command journaling as default durability** (kept as Workflow-tier option) — see §9.3.
- **LLM-router orchestration as a primitive** (Mastra networks: 2.7k lines, OM-incompatible, self-admittedly hallucination-prone) — routing stays prose delegation inside charters.
- **Mutation-based extension hooks** (pi's in-place event mutation, Mastra's 9-hook processor accretion) — our powers come from substituting implementations, and §0.2's claim (b) is hereby sharpened: the contrast is *open typed seams + compile-time requirements* vs *closed hook vocabularies that grow a method per need*.
- **A "run" as a durable entity** — the DO persists fold + trace + inbox; "a run is active" is derivable, never resurrected. [OpenCode doctrine]

---

## Appendix A — the loop taxonomy article (verbatim)

https://x.com/aparnadhinak/status/2073492320159510869

The AI engineering world adopted a new favorite word this month, and it means at least four different things: the loop.
We're currently at the peak of the hype cycle. On June 7, Peter Steinberger posted that you shouldn't be prompting coding agents anymore, you should be designing loops that prompt your agents. That same week, Boris Cherny of Anthropic said on stage that he doesn't prompt Claude anymore: "I write loops, the loops do the work." Addy Osmani published an essay called Loop Engineering on June 7, swyx published Loopcraft: The Art of Stacking Loops on June 12, and LangChain published The Art of Loop Engineering on June 16. Then came the AI Engineer World's Fair, where the word dominated the main stage. Swyx's keynote was about Loopcraft, an entire track was devoted to software factories, speaker after speaker reached for the same word, and the conference closed on July 2 with an hour-long debate about whether the hype behind loops has outrun what works in practice.
The problem is that people talking about loops are not discussing the same thing. I counted at least four distinct architectures hiding behind that one word. So this post is an attempt to map out what everyone means.
1. The execution loop: the agent's own act-observe cycle
This is the loop most people picture when they say "agent": call a tool, read the result, decide the next action, repeat until there are no more tool calls to make. It's what Addy calls the inner execution loop, the part agents can now run largely on their own, and it's the innermost loop you can engineer (swyx's stack has a token loop, but nobody designs the token loop, it’s just part of the model).
Swyx's Loopcraft diagram
The execution loop iterates on steps within one task. It ends on environment feedback: the test output, the API response, the file contents. Humans are usually absent mid-loop and appear at the boundaries, approving plans or reviewing results. It also ends whenever the agent decides it's done, whether or not it actually is. The first fix the field found for that was to wrap this loop in another one that doesn't take the agent's word for it.
2. The task loop: restart the agent until the spec is satisfied
This was the first loop to get a name and it’s Geoffrey Huntley's Ralph Loop, which got name-checked from the AI Engineer World's Fair main stage when Allie Howe of Keycard introduced the software factories track by citing his article everything is a ralph loop. A Ralph loop restarts a coding agent against the same specification over and over, allocating a completely fresh context window every iteration and doing exactly one task per loop. The apparent waste is the point: re-feeding the full spec each time prevents the context rot and compaction events that quietly degrade long-running sessions.
What this loop iterates on is a single artifact. What ends the loop is spec compliance and passing tests. The human writes the spec and judges done-ness, and in Geoffrey's telling the human has one more job that I'll return to later: watching the loop, spotting failure patterns, and fixing them so they never recur. In the closing debate on the conference's final day he compared the role to a locomotive engineer, someone whose whole job is keeping the train on the rails. Zoom out from a single spec, though, and a much bigger loop comes into view: the one that runs an entire codebase.
3. The product loop: the software factory
This was the loudest version at the AI Engineer World's Fair. Tereza Tížková of Factory defined a software factory as "the whole loop, the whole lifecycle of developing software with autonomy," and Zach Lloyd of Warp got specific about what that lifecycle is in an interview with Latent Space: triage, specification, implementation, review, verification, shipping, and monitoring. Zach's claim is that software engineering becomes factory engineering, and that you'll be building the thing that builds the product. Warp is dogfooding this: the company placed its own open-sourced repo under the control of Oz, its factory platform, and Zach describes the adoption path as starting with low-risk repos and ratcheting the automatic PR merge rate upward from 20 percent toward 60. Anthropic appears to be running the same experiment internally: the company says 65 percent of its product team's code is now created by its internal version of Claude Tag, and Mike Krieger described his team's use of it at the World's Fair as delegated and proactive: not "fix this bug" but take responsibility for this part of the codebase, monitor this feedback channel, and pick up tasks on your own.
The task loop and the execution loop have defined exit conditions; the product loop iterates on a codebase and its backlog, continuously, and its closing signals come from outside the codebase entirely: new issues, production logs, user feedback, review outcomes. The human role becomes configurable. In Zach's framing, you pick the parts of the lifecycle to automate and the points where humans get brought in, and organizations differ on questions like whether code review stays human for high-risk changes. A factory improves a product. The next loop improves the factory itself.
4. The system loop: autoresearch
Roland Gavrilescu of Introspection calls this autoresearch, and his framing in the Latent Space interview is the cleanest: the inner loop is your primary system doing user-facing work, and the outer loop studies and maintains the primary system. It iterates on prompts, harnesses, model choices, and the evals themselves. His one-liner is that the loop is the product.
This pattern now has real existence proofs at both ends of the scale. The minimal case is Andrej Karpathy's autoresearch from March 2026, roughly 630 lines of Python that ran 50 hypothesis-edit-evaluate experiments overnight on one GPU. The shipped case is Meta's Brain2Qwerty v2, announced in late June, where the researchers report that agents iteratively modified the codebase to invent better decoding architectures, producing a substantial improvement in word error rate. Meta's caveat is instructive: final training configurations were still selected by hand. Even the flagship system loop keeps a human at the last checkpoint.
What ends this loop is the most demanding signal set of the four: evals, judges, filtered product feedback, and, in Roland's design, an explicit ask-a-human tool through which the agent accumulates tacit knowledge the way a new employee does. And that's the top of the stack. Put the four together and the shape of the whole system becomes visible.
The four loops side by side
What about Agentic MapReduce?
One famous pattern from the same week is missing from this map on purpose. Cognition's Devin Security Swarm fans parallel bounded agents out across a repository and aggregates their findings, a shape they call Agentic MapReduce, and it gets called a loop. I don't think it is one. Dispatch, gather, validate is a pipeline: nothing feeds back into a next cycle, and a loop without feedback is just a for statement. Fan-out is a topology you can deploy inside any of the four loops, not a loop of its own.
The unnamed loop at the top is the oversight loop
In swyx’s loop diagram, the outermost ring, the one above the loop that makes loops, is literally labeled "???? loop." Its verbs are set goals, allocate, cull. Its exit condition is listed as none.
I think that loop has a name. I'm calling it the oversight loop: it's where goals get set, budgets get allocated, and work gets culled, and it's the one ring where a human should live. Addy said on the AIEWF stage: "That inner loop is capability. The outer loop is agency." Agency is exactly what the oversight loop holds.
The loop stack, exits named. The arrow in each ring is where it ends.
And the sharpest disagreements at AIEWF were all, once you translate them, arguments about who runs that top ring. Zach and Roland make the case for turning the dial up: pick your checkpoints deliberately, ratchet autonomy as trust accumulates, and, in Roland's memorable distinction, build orchestras before factories, where an orchestra is a system that keeps a human conductor. The other camp says the dial has a stop. Geoffrey Litt of Notion called factories a depressing vision on X and argued, in a talk he has since published as an essay, that those who delegate understanding get replaced by the agent. Paul Bakaus put it as flatly as it can be put: "There is no auto, and there will be no auto." His argument isn't only about quality, it's about ownership. People need purpose, and they want a role in what they create.
The closing debate, covered in Latent Space's conference reporting, put both positions on one stage. Dex Horthy of HumanLayer took pains to say he isn't anti-loop, pointing out that Kubernetes is built on control loops, but deterministic ones, and his worry is that enthusiasm has gotten ahead of the engineering. His advice was to step down an abstraction level rather than up. Geoffrey took the other side and called loops inevitable. And Mike offered the most honest data point of all: even inside Anthropic, the team running Tag reports being bottlenecked on reviews and on the human ability to conceptualize what the system is doing. The checkpoint humans kept for themselves is now the constraint.
Autonomy is a dial that exists separately on every one of the four loops. You can run a fully autonomous execution loop inside a heavily supervised product loop. You can hand the system loop to agents while keeping goal-setting entirely human. The interesting engineering question isn't which camp wins, it's what information you'd need to set each dial correctly.
The table above is my attempt to fill in those blanks. Every loop, including the top one, has a nameable exit condition, and the top one is you. But naming a signal is not the same as wiring it in. A loop without its signal doesn't converge, it just runs until something external stops it. Knowing whether your loops are actually closing, at production scale, means sweeping traces ‹and clustering failures continuously instead of spot-checking transcripts, which is exactly the job Arize AX was built to do.
Which one are you building?
Now the loops have names, that's the question to ask. The word loop is doing a lot of work this month, because this field loves nothing more than jumping on the next hot thing. But real practice underlies all four loops, and it's the same practice in each: people are dialing up their level of abstraction and pushing human judgment further up the stack. That's the actual lesson of loops. We get more done by climbing up the stack, and now you have a map you know where you should climb.