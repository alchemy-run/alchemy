# Reassessment — the proposal (synthesis of five reports)

Status: **BUILT** (July 2026). All of A–F landed, each tested and
committed; the example is rebuilt as the tutorial (§E). Summary of
what shipped:

- **A** — control refs render in prose (`Render.ts` fixed; the halt
  contract, budget ceilings, concurrency, and triggers now reach the
  model where the author wrote them; zero constructor changes).
- **B** — machine-observed exits: `AI.until(eventSource)` settles a
  goal run on a world event (no `resolve` tool); one work round then
  park. Per-item correlation, multi-round-before-park, steer-during-
  park, and fold-seeded re-admission remain follow-ups.
- **C** — `AI.process(term, handler)` + `ProcessContext`: deterministic
  processes with the full ProcessService (mailbox, dispatch, triggers,
  steer, interrupt, `run.settled`), the default coordinator form.
- **D** — perpetual/goal doctrine lints (`AI.never` + check/fold/
  budget/delegates), warnings pending fixture migration.
- **E** — the example shows a channel three ways: deterministic
  (`#engineering`), prose (`#support`), and a machine-observed goal
  (`#issues`).
- **F** — `AI.value(Tag)` dynamic prose (per-run tool exposure filter
  deferred).

Synthesizes:
[deterministic orchestration](./reports/reassess-deterministic-orchestration.md),
[exit conditions](./reports/reassess-exit-conditions.md),
[control refs](./reports/reassess-control-refs.md),
[perpetual vs goal](./reports/perpetual-vs-goal.md),
[Process abstraction](./reports/reassess-process-abstraction.md).

## The one-paragraph verdict

We did **not** over-generalize the architecture — Agent and Process
genuinely denote one object, and the typed goal run (`dispatch:
Effect<Out, BudgetExceeded | Refused>` with `Out` derived from the
exit) is the framework's real novelty and is *not* free from
bare-Agent-plus-Effect-code. We over-generalized the **presentation**:
we shipped the rare case (a prose LLM coordinator) as the first
example, left the common case (deterministic Effect code calling
agents) unbuilt and undocumented, put kernel machinery (`check`,
`fold`, `concurrency`, `budget`) into template syntax where the
renderer was *already erasing it to empty strings*, and modeled an
episode's exit (`AI.until(S.String)`) on a perpetual entity (the
Channel). The fix is **"make deterministic orchestration the default,
demote the prose charter to an opt-in, move control wiring to
config, and give exits three sources"** — not "delete Process."

Every report reached this independently. The convergence is the
signal.

### Typed serving boundary (follow-up from live thread use)

The UI transcript is a transport/materialized-view type, never a
process's domain input. `ChatSessions` routes through typed
`chatTarget(process, adapter)` pairs: the adapter converts
`UIMessage[]` into the target's declared `In` (`PostThread`,
`IssueWorkItem`, …), and TypeScript proves the two match. A
deterministic coordinator therefore receives `PostThread`, not
`unknown` / raw `Prompt.Message[]`; domain code owns its formatting
before dispatching member agents. Authored `data-message` replies are
semantic conversation history and must survive the adapter. Generic
stringification is confined to internal diagnostic/prompt projection,
not exposed as an orchestration API.

## The five findings, each in two lines

1. **Deterministic orchestration** — Effect already *is* the workflow
   language (every surveyed framework converged on "workflow = code,
   agents = typed functions"); `ProcessService.dispatch` is that
   primitive. Missing: a helper to lift a plain handler into a term's
   ProcessService, so hand-written coordinators get triggers, mailbox,
   and Trace for free.
2. **Exit conditions** — the algebra is fine (`Out` is run-scoped), but
   exits have only ONE implemented source (model calls `resolve`).
   Real entities need three: **model-declared**, **machine-observed**
   (a GitHub issue closes by *world state*, not a model claim), and
   **human-declared**. The Channel put a Post's exit on the channel.
3. **Control refs** — `Render.ts` renders every control ref to the
   **empty string**; the budget is never even shown to the model. So
   interpolation buys control refs nothing prose-wise — they should be
   a structured config argument, with judgment prose kept as config
   *values* (`until: AI.until(S)\`…\``).
4. **Perpetual vs goal** — perpetuity belongs to the *ring*
   (deterministic, derived by `serve`); goals belong to the *run*. A
   perpetual process should almost never be an LLM loop — and the
   kernel already implements it that way (`AI.never` = one default turn
   per item). "Servers are topology; jobs are work."
5. **Red team** — sustained against the surface (control-in-prose, the
   LLM-coordinator example, the missing code path), overruled against
   the structure. Keep Agent + `ProcessService` + the Process term;
   demote the term to opt-in; make deterministic the default; **no
   rename**.

## The user-facing vocabulary (after)

Taught in this order — common first, rare last:

1. **`Tool`** — a capability (typed params + handler).
2. **`Agent`** — an LLM with tools. The primitive most apps need.
3. **`EventSource`** — a typed world event stream.
4. **Plain Effect code** — the orchestration language: `Effect.gen`,
   `Effect.all({ concurrency })`, `Effect.race`, `Match`. Calls agents
   via `agent.dispatch(item)`.
5. **`AI.process(term, handler)`** — lift a deterministic handler into
   a term's `ProcessService` (mailbox, triggers, steer, interrupt,
   Trace) without hand-rolling the five verbs. The default way to write
   a coordinator/router/channel.
6. **The `Process` term (prose charter)** — the *deliberately rare*
   artifact: a genuinely agentic goal job whose action set isn't
   enumerable, with a typed exit, budget, and check. What you reach for
   when a `switch` can't be written.

`ProcessService` is the shape everything resolves to — so a
code-implemented server and a prose goal process interpolate into each
other's charters identically (`${Sage}` works whether Sage is prose or
`Layer.effect`).

## The changes (grouped; each independently shippable)

### A. Control refs stay in prose — fix the renderer (report 3 **v2**, supersedes)

**Reversed after owner review.** The original §A moved control wiring
to a config argument (`until: AI.until(S.String)\`…\``). The owner
rejected it: the `AI.until` wrapper-as-config-value is redundant, and
the real bug was never "prose vs config" — it was that
`displayRef` renders every control ref to the **empty string**. Fix
the *rendering* and control refs belong in the prose, where they read
naturally and the author put them.

```ts
// UNCHANGED from what authors write today — control refs stay interpolated
class Fix extends AI.Process<Fix>()("Fix")`
…prose (tools, agents, policy)…
${AI.until(S.String)`the tests pass`}
${AI.budget({ iterations: 8 })}` {}
```

The change is entirely in `Render.ts` + `KernelPrompts.ts` (zero
constructor call sites change):

- `${AI.until(S)\`…\`}` renders the full kernel-worded halt-contract
  block **in place**, replacing the kernel's separately-appended
  `# Halt condition` heading (the model-visible prompt is
  byte-equivalent — now honestly authored where it stands).
- `${AI.budget({ iterations: 8 })}` renders a `budgetNote` block — the
  model is finally told "you have at most 8 iterations" (today it is
  told *nothing*; the number only sets `maxIterations`).
- `${AI.concurrency(3)}` / `${AI.on(…)}` / `${AI.each(…)}` render
  inline as their values (today "at most `${AI.concurrency(3)}` in
  flight" renders as "at most in flight").
- `check` / `fold` correctly keep rendering `""` in the host prompt —
  their prose renders into the *verifier's* and *fold agent's* prompts
  (recipient-scoped), which is already how the kernel routes them.
- Type derivation (`Out`/`In`/`Err`/`Req` over the refs tuple) is
  **untouched** — the ref was always both a type carrier and a render
  token; only `displayRef` was stubbed. `until`+`never` stays a lint
  (not promoted to a type error — the config shape that would have
  bought that is gone).

The naming complaint dissolves with the config shape: `${AI.until(S)\`…\`}`
reads fine as an interpolation; it only looked silly as `until:
AI.until(…)`. All spellings survive unchanged. Full analysis:
[reassess-control-refs-v2.md](./reports/reassess-control-refs-v2.md).

### B. Exit sources: model / machine / human (report 2)

`until` accepts three source shapes, symmetric with triggers
(`AI.on(source)` derives `In`; `AI.until(source)` derives `Out`):

```ts
until: AI.until(S.String)`…`                 // model-declared (today): halt-as-tool
until: AI.until(Github.IssueClosed(repo))    // machine-observed: run settles on the EVENT
until: AI.untilApproved(reviewer)            // human-declared: Ask in halt position
```

- Machine-observed exits have **no `resolve` tool** — the run ends when
  the world event arrives (the reconciler doctrine transposed to exits:
  observation > claim). The event source's channel tag joins `Req`.
- **Reopening** (issue reopened) never resumes the settled run: re-admit
  the same `(term, work item)` key as a NEW run, fold-seeded from the
  key's prior Trace, fresh budget. No new "Case" entity — run key +
  Trace + fold already are the case file.

### C. The deterministic path, made first-class (reports 1, 4)

- **`AI.process(term, handler)`** (~150 LOC, extracted from
  KernelMemory's ring): `(item, ctx) => Effect<Out, Err>` becomes a
  full `ProcessService` — mailbox, `dispatch = send + await`,
  trigger-lift, steer queue, interrupt.
- **`ProcessContext`** — `ctx.emit(...)`, `ctx.post(author, text)`,
  `ctx.dispatch(childTerm, item)` so hand-written coordinators write
  `message.posted` rows through the `TraceStore` seam; timelines and the
  run inspector render identically to prose processes.
- **Prose-free Process terms** — a refs-only / config-only term (no
  charter) is legal; a lint fires only when a charter-less term meets a
  prose-requiring path.

### D. Perpetual/goal doctrine + lints (report 4)

- Vocabulary in docs: **server** (ring, deterministic, derived by
  `serve` — perpetual whether or not `AI.never` is written) vs **job**
  (run, goal, typed exit). "Perpetuity is derived, never authored."
- `AI.never` kept, but scoped to the **conversation shape** (item =
  message, reply = deliverable, human = the check) and honestly
  single-turn daemons.
- Lints: `AI.never` + `check` → error; + `fold` → error; + `budget` →
  warning; + multi-step delegation → info ("consider `AI.until`").
- Standing memory doctrine: world artifacts, per-run folds, serving-tier
  views — never an unbounded cross-run transcript. `seed: []` is
  normative.

### E. The example, rebuilt as the tutorial (all reports)

`examples/agent-chat-web` gains **GitHub Issues** and shows the
contrast:

- **`Channel`** = deterministic `AI.process` coordinator: on each Post,
  a routing classifier *leaf* (one `generateObject` with a typed
  fallback) picks members, `Effect.all` fans out to their agents,
  `ctx.post` relays — no LLM in the coordination path. ~30 LOC.
- **`IssueWork`** = a goal Process (prose charter) with a
  **machine-observed** exit `AI.until(Github.IssueClosed(repo))` —
  the model works the issue; the run settles when GitHub says closed;
  reopening re-admits. This is the exemplar of "well-defined exit
  condition owned by the world, not the model."
- **`Thread`/`Post`** = a goal Process — the per-Post job the Channel
  dispatches, carrying the `AI.until(S.String)` resolution the Channel
  wrongly carried before.
- Ship the **prose Channel variant beside the code variant** — the
  contrast (when is a coordinator worth an LLM?) is the lesson.

### F. Dynamism within a static upper bound (report 6)

Full analysis: [dynamic-prose-and-tools.md](./reports/dynamic-prose-and-tools.md).
The unifying principle: **`Req` is a static upper bound on capability;
realization is dynamic within it.** Narrowing is safe anywhere;
widening only in source (or one explicitly-marked escape hatch). Keeps
static-by-default (type-safe capability sets, capability-by-omission,
`AI.topology`) while allowing the dynamism real apps need.

- **Now — dynamic prose values:** `${AI.value(Tag)}` interpolates a
  service-resolved string into an otherwise static charter (RAG
  context, observed state, user name). Its tag joins `Req`; topology
  sees a typed hole; the prompt hash stamps per interpretation.
  Per-*run* data (the user message, retrieved docs) rides `In`/tool
  results, never the system prompt (prompt-cache doctrine).
- **Now — per-run tool exposure:** `Req` = the full declared tool
  union (upper bound); a typed filter service shrinks the *exposed*
  set per run (admin-only tools, context-scoped). Granted-but-not-
  exposed is sound — that's what "upper bound" means; filters only
  shrink.
- **Soon — runtime instances:** `AI.instantiate(kind, name, prose)` —
  a DB row fills only the *body* of a static kind whose scaffold refs
  fix `Req` statically; a static registry process fronts N instances.
- **Deferred — MCP / dynamic tool universe:** one static tag for the
  source (`AI.dynamicTools(Source)`); discovered tools are honestly
  typed as untyped-extra, outside the static `Req`; exposure filters
  still apply.
- **Refused permanently:** charter-as-`(ctx) => template` (erases the
  refs tuple, kills `Req` derivation), runtime-widened tool universes
  outside the marked ref, string-keyed term registries where data
  creates structure. Refusal is the feature: capability structure
  changes only by editing source — the oversight surface stays the
  source file.

## Build order

1. **A** (fix the renderer so control refs render in prose) — small,
   self-contained (`Render.ts` + `KernelPrompts.ts` + two deletions in
   `KernelMemory.ts` + one lint); zero constructor call sites change.
   Do it first: it makes the current syntax honest before anything
   else is authored.
2. **C** (`AI.process` + `ProcessContext` + prose-free) — unblocks the
   deterministic example.
3. **B** (exit sources) — `AI.until(eventSource)` + re-admission; needed
   for GitHub Issues.
4. **D** (doctrine + lints) — pure, cheap, locks in the defaults.
5. **E** (the example: Channel-as-code, IssueWork, prose variant) +
   an OrgStress-style live test.
6. **F** (dynamism: `AI.value` + exposure filters) — cheap (one ref
   kind + one `RefServices` arm each), no `Out`/`In`/`Err` impact;
   slot in when a use-case demands it.
7. Docs: invert the teaching order (Tool → Agent → Effect → `process` →
   charter last) in the design docs; update org-chat.md and
   alchemy-ai-design.md §1/§2.5/§2.11.

## What we explicitly are NOT doing

- Not deleting Process, not renaming to Agent/Job/Daemon (report 5).
- No workflow step-graph DSL — Effect combinators over `dispatch` are
  the workflow language (reports 1, 4); they only typecheck against
  goals, which is the type system enforcing the doctrine for free.
- No new term kind for `Server`/fan-out — `serve`'s output, not an
  axiom.
- No durable-workflow engine now — arrives with the Phase-3 ring ladder.
