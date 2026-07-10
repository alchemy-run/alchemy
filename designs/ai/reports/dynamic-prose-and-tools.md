# Dynamic prose and dynamic tools — research report

Status: research (July 2026). Question (owner, verbatim): *"Another thing
to research is dynamic prose and dynamic selection of tools. We're pretty
static, which I think is useful. But not sure how we'd also support more
dynamic definitions of processes and agents."*

## 0. The one-line answer

The unifying frame holds: **`Req` is the static upper bound on
capability; realization is dynamic within it.** Every axis of dynamism
that only *narrows or fills in* within the statically declared bound
(prose values, tool subsets, kind instances) can be supported without
losing capability-by-omission, `AI.topology`, or Layer-checked
provisioning. Every axis that would *widen* capability at runtime
(arbitrary tool universes, arbitrary term structure) must either enter
through one explicitly-marked escape-hatch tag or be refused.

## 1. The four axes, ranked by strain on the static model

| # | Axis | Example | Static model… |
|---|------|---------|---------------|
| 1 | **Prose values** — runtime data interpolated into a fixed charter | user name, repo state, RAG context | **holds** (bend at most) |
| 2 | **Tool selection** — runtime subset of a fixed tool universe | admins get `${Deploy}`, others don't | **holds** |
| 3 | **Tool universe** — tools with no compile-time tag | MCP discovery, plugins | **breaks per-tool**; containable to one tag |
| 4 | **Term structure** — Agent/Process built from data | persona from a DB row | **breaks tag identity**; recoverable via kinds |

Why the ranking: (1) touches only the *string* channel — `Req`, `In`,
`Out`, `Err` are untouched. (2) touches which compiled tools reach the
model but not what the Layer graph must provide — `Req` is already the
upper bound, never a promise of exposure. (3) is the first axis where a
capability exists that **no ref names** — the constitutional mechanism
(denial by absence-of-ref) has nothing to bite on per-tool. (4) loses
the thing everything else is built on: the term-as-`Context.Service`
tag, and with it typed `dispatch`, Layer-checked provisioning, and
source-derivable topology.

## 2. What alchemy already permits (the compile-time / interpret-time seam)

Verified in code — a term is a static **shape**; its **realization is
already late-bound**, just at *interpretation* (Layer build) rather than
per run:

- **Charter rendered at interpretation.** `KernelMemory.interpretAgent`
  computes `system: renderTemplate(term.template, term.refs)` when the
  ring is built (`KernelMemory.ts` ~802), not at class definition. The
  render is pure/deterministic (`Render.ts`) to keep `promptHash`
  content-addressing — but the *call site* is already inside an Effect
  with ambient context. The seam for context-resolved prose exists;
  only the renderer's purity contract stands in the way.
- **Tools compiled at interpretation.** `compileTools` resolves every
  tool tag and delegate tag from **ambient context** via
  `Effect.serviceOption` (~1450, ~1560). A Tool *implementation* is a
  Layer and can close over anything — request scope, feature flags, a
  database. Behavior is already fully dynamic; only the *schema +
  description + membership* of the toolkit is static.
- **Delegation is a Layer-graph fact.** Which ring serves
  `${Engineer}`, with which tool physics, shared or private — decided
  entirely by Layer composition, not by the charter (§1.4).
- **Per-scope realization exists today.** Interpretation happens per
  Layer build; building the Layer graph per tenant/request scope gives
  different realizations of the same static term. What does **not**
  exist is per-*run* realization: `system` and `compiled` are fixed for
  the ring's lifetime.
- **Runtime template surgery exists.** `spliceCharter` + `ProcessKind`
  (`Process.ts`) compose templates as data at runtime; `makeProcess` is
  an ordinary function. Terms are values — runtime construction is
  *mechanically* trivial; what's lost is typing (§5.4).
- **Strings/numbers already interpolate.** `displayRef` renders
  `string | number` refs directly — module-eval-time dynamism (config
  constants in charters) already works.
- **`Layer.effect(Agent, myImpl)` bypasses the kernel entirely** — the
  existing total escape hatch: an implementation may ignore the charter.

Prior art in our own reports: `reports/vercel-academy.md` §18 already
flags the tension (skills lists / environment-derived prompt content vs
the pure renderer) and asks the design doc to decide where such content
lives. This report is that decision.

## 3. Framework survey — how others buy dynamism, and what it costs

- **OpenAI Agents SDK.** `instructions` may be `(context, agent) =>
  string` (sync/async); per-tool `is_enabled: (context, agent) =>
  bool` hides tools per run; MCP servers take a `tool_filter(ToolFilterContext,
  tool)`. Cost: context is one user-typed generic on the run; nothing
  derives *which* capabilities an agent holds — the tool list is a
  runtime value, topology and least-privilege are unverifiable.
- **Mastra.** `instructions` / `model` / `tools` may each be functions
  of `runtimeContext`; `requestContextSchema` validates the context —
  **at runtime** (throws on `generate`). Cost: the toolset is
  `Record<string, Tool>` chosen by arbitrary code; two calls to the
  same agent can be entirely different agents; no static story at all.
- **LangGraph.** Everything is state-driven: prompts assembled per node
  invocation from graph state; `model.bind_tools(subset)` per call;
  conditional edges / `Command` make even the topology runtime-chosen.
  Cost: maximal dynamism, capability reasoning only by whole-graph
  inspection; the type system checks state channels, never capability.
- **MCP.** Tools are discovered by `list_tools()` at connect time;
  schemas arrive as runtime JSON Schema. Zero compile-time identity by
  design — the *protocol* is the dynamic-universe axis in pure form.
  Consumers (Agents SDK) immediately re-add static-ish control via
  allow/block-lists and filters.
- **Inngest AgentKit.** `system` may be `({ network }) => string`
  resolved per turn from shared network state; routers are functions.
  Same cost profile as Mastra.

Pattern: every framework converged on **prose-as-function-of-context**
and **tools-as-runtime-filter** — and every one paid with the total
loss of static capability reasoning, because their context object is a
grab-bag and their tool list is a plain array. Alchemy can adopt the
same two moves *without* that cost, because our "context" is typed
ambient `Context` and our tool list is a typed refs tuple.

## 4. Per-axis proposals

### 4.1 Dynamic prose values — `AI.value(Tag)` (support now)

A new capability-shaped ref: interpolating a service tag *as a value*
renders whatever that service resolves to at interpretation time.

```ts
class UserName extends Context.Service<UserName, string>()("UserName") {}

class Concierge extends AI.Agent<Concierge>()("Concierge")`
You are the concierge for ${AI.value(UserName)}. ${Search} before
answering.` {}
// Req = UserName | Search — the value's tag joins Req like any ref
```

Typing sketch: `interface Value<Tag> { "~alchemy/Kind": "Value"; tag: Tag }`;
`RefServices` gains an arm `R extends Value<infer T> ? ServiceId<T> : …`.
The kernel resolves the tag at interpretation (exactly like a tool impl)
and hands the resolved string to the renderer.

Consequences, priced:

- **Renderer purity**: `render(term)` stays pure over the *shape* (the
  hole renders as `{UserName}`); the interpretation-time render is
  `render(term, resolvedValues)` and `promptHash` is stamped **per
  interpretation** — which the fossil-check design (eve report: compare
  checkpoint `promptHash` against current) already accommodates. Hash
  drift on redeploy/re-provision is handled by the existing `Resume`
  policy, not a new mechanism.
- **`AI.topology` survives**: the topology sees a named, typed hole
  (`value:UserName`), not opaque prose. Strictly better than a
  `(ctx) => string` charter, which would make the whole charter opaque.
- **Per-RUN data is refused on this axis**: RAG context, the current
  work item, observed state ride the **`In` channel** (the kernel
  already renders the item into the user message — `toMessages`) or
  tool results — never the system prompt. This is also the
  cache-stability doctrine (stable prefix / fresh tail): a per-run
  system prompt would nuke the prompt cache every dispatch. So:
  per-*interpretation* values in the charter, per-*run* values in `In`.

Rejected alternative: charter as `(ctx) => template`. It erases the
refs tuple from the type (the template only exists after calling with a
runtime ctx), which kills `Req` derivation — the one thing we cannot
spend.

### 4.2 Dynamic tool selection — exposure filters (support now)

The term declares the **universe** (Req = the union, as today); a
runtime **exposure filter** decides the per-run subset. Config, not
prose (per the reassess direction: control is config):

```ts
class Ops extends AI.Agent<Ops>()("Ops", {
  expose: AI.exposure(OpsExposure),   // optional; default = expose all
})`…${ReadLogs} ${RestartService} ${Deploy}…` {}

// the filter is itself a service — provided as a Layer, closing over auth:
class OpsExposure extends Context.Service<OpsExposure,
  (tool: "readLogs" | "restartService" | "deploy",  // ToolNames<Refs> — typed!
   run: { item: unknown }) => Effect.Effect<boolean>
>()("OpsExposure") {}
```

Typing sketch: `ToolNames<Refs> = Extract<Refs[number], Tool>["~alchemy/Name"]`
— the filter's domain is the statically-known name union, so a filter
naming a nonexistent tool is a type error. `Req` gains the exposure
tag; nothing else changes. `compileTools` compiles the full universe
once; the kernel applies the filter to toolkit membership per run (or
per turn) — handlers for unexposed tools simply aren't offered.

Soundness of "granted in type, never exposed": **yes, acceptable — it
is the definition of an upper bound.** `Req` never meant "the model
will see this tool"; it means "the deployment must be *able* to supply
it." Capability-by-omission is preserved exactly: a filter can only
shrink the universe, never add to it — `${Approve}` absent from the
charter still cannot be exposed by any filter. The audit story even
improves: "what could this agent ever do" is static; "what could it do
for user X" is one pure function.

### 4.3 Dynamic tool universe (MCP) — one marked escape-hatch tag (defer)

Runtime-discovered tools have no compile-time tag, so they cannot enter
`Req` per-tool. Don't pretend. Let the **provider** be static and the
tools dynamic:

```ts
interface DynamicTool { name: string; description: string;
  parameters: JsonSchema; call: (args: unknown) => Effect.Effect<unknown, unknown> }
interface DynamicToolSource { list: Effect.Effect<ReadonlyArray<DynamicTool>> }

class GhMcp extends Context.Service<GhMcp, DynamicToolSource>()("GhMcp") {}

class Triage extends AI.Agent<Triage>()("Triage")`
…${AI.dynamicTools(GhMcp)}…` {}      // Req gains GhMcp — ONE tag
```

`compileTools` calls `list` at interpretation (optionally re-listed per
run), converts each `DynamicTool` to an `AiTool` with its runtime JSON
schema, and marks every such tool as **untyped-extra** in the Trace and
in `AI.topology` (rendered as `+ dynamic via GhMcp`, never enumerated).
The exposure filter of §4.2 applies to them too (its domain widens to
`ToolNames<Refs> | (string & {})`).

What this preserves: absence-of-ref still governs — no
`${AI.dynamicTools(…)}` ref, no dynamic tools, ever; the *source* is a
Layer (mockable, swappable, deniable). What it honestly gives up:
per-tool constitutional reasoning inside the dynamic set. That loss is
intrinsic to MCP, not to our encoding; the design's job is to quarantine
it behind one visibly-marked ref rather than let it leak into the core.
Defer until a concrete MCP integration demands it; reserve the name.

### 4.4 Dynamic term structure — kind-mediated only (support the narrow case; refuse the general one)

Terms are values, so `makeProcess(name, strings, refs)` already *runs*
at runtime. What a runtime-built term lacks: a compile-time `Self`
(nobody can `yield* it` with a type), a statically-known `Req` (Layer
provisioning can't be checked — the exact failure `compileTools` dies
on), and membership in source-derived `AI.topology`.

The recoverable case is **instances of a static kind** — and
`ProcessKind` is already 90% of it. The kind fixes the capability upper
bound (its `ScaffoldRefs` — tools, triggers, budget, exit); the DB row
supplies only name + prose body:

```ts
const Persona = AI.Process("Persona", {
  charter: (name) => AI.charter`You are ${name}. ${AI.body}
  ${Search} ${Reply} ${AI.budget({ iterations: 4 })}`,
});

// runtime: rows can only fill the body — refs come from the KIND
const fromRow = (row: { name: string; prose: string }) =>
  AI.instantiate(Persona, row.name, row.prose);
// : Process<Out, In, Err, Services<ScaffoldRefs>>  — Req known STATICALLY
```

Typing sketch: `AI.instantiate(kind, name: string, prose: string)`
returns `Process<…, Services<ScaffoldRefs>, string, ScaffoldRefs>` —
every channel statically known *because the row contributes no refs*.
The instance's tag is minted at runtime (the `Context.Service` key is a
runtime string already), so it can't be `yield*`ed by class name; it is
served through a **registry process** — a static term whose `In`
carries the persona key and which holds the kind's Layer requirements
once (`Req = Services<ScaffoldRefs>`), interpreting instances on demand.
One static tag fronting N dynamic instances; provisioning type-checked
against the kind.

**Refuse** the general case: a DB row that names its own tools. The row
would carry strings; strings→terms needs a string-keyed registry of
every tool; typing degenerates to `unknown` at exactly the
constitutional boundary — this is LangGraph with extra steps. Refusal
is the feature: *the set of capabilities in the org changes only by
editing source* (§0 claim 10 — "the oversight loop is the source
file"). Data may choose *within* structure; only code may create
structure.

## 5. The layered recommendation

1. **Now (cheap, preserves statics):** `AI.value(Tag)` interpolation
   (§4.1) and exposure filters (§4.2). Both are one new ref/config kind
   + one `RefServices` arm + a small kernel change; neither touches
   `Out`/`In`/`Err`; both *strengthen* the story ("static shape, typed
   holes").
2. **Now (doctrine, zero code):** per-run data rides `In`/tool results,
   never the charter; document the per-interpretation `promptHash`
   stamping and its interaction with the fossil check.
3. **Soon:** `AI.instantiate(kind, …)` + the registry-process pattern
   (§4.4) — mostly exists as `spliceCharter`/`ProcessKind`; needed the
   moment personas/org-charts live in a database (org-chat is heading
   there).
4. **Defer:** `AI.dynamicTools(Tag)` (§4.3) until a real MCP demand;
   reserve the design so nobody solves it with a string registry.
5. **Refuse, permanently:** charter-as-function-of-run-context
   (kills `Req` derivation + prompt cache); runtime-widened tool
   universes outside the marked escape hatch; string-keyed term/tool
   registries (data creating structure).

The principle to write into the design doc: **the type is the upper
bound; the run is the realization.** `Req` bounds what a deployment
must be able to supply; interpretation resolves values and universes
from ambient context; runs select within them. Dynamism that narrows is
welcome everywhere; dynamism that widens happens only in source — or
through one ref that says so out loud.
