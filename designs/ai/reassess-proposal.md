# Reassessment — the proposal (synthesis of five reports)

Status: **proposal for approval** (July 2026). Synthesizes:
[deterministic orchestration](./reports/reassess-deterministic-orchestration.md),
[exit conditions](./reports/reassess-exit-conditions.md),
[control refs](./reports/reassess-control-refs.md),
[perpetual vs goal](./reports/perpetual-vs-goal.md),
[red team](./reports/reassess-red-team.md).

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

### A. Control wiring → structured config (report 3)

The constructor gains a config object; the template keeps only
capability refs and (optionally) inline splices:

```ts
// before: control refs tacked onto the template tail
class Fix extends AI.Process<Fix>()("Fix")`
…prose… ${AI.until(S.String)`tests pass`} ${AI.budget({ iterations: 8 })}` {}

// after: control is config; judgment prose stays as config VALUES
class Fix extends AI.Process<Fix>()("Fix", {
  until: AI.until(S.String)`the tests pass`,   // judgment prose preserved
  budget: { iterations: 8 },                    // pure config
  on: Issues,                                   // trigger
})`…prose (tools, agents, policy only)…` {}
```

- `Out`/`In`/`Err` derive by keyed lookup on the config (`C["until"]`)
  instead of `Extract` over the refs tuple — simpler inference, and
  `until`+`never` / duplicate-budget become **type errors** not lints.
- The kind form gains typed constitutional config: instances may *add*
  budget/triggers but not *override* the kind's (replaces
  `spliceCharter` smuggling halts through prose).
- New `kernelPrompts.budgetNote(limits)` finally tells the model "you
  have at most 8 iterations" — the prose the owner expected, rendered
  from config, byte-stable.
- Prose MAY still splice a config'd value inline where narration
  matters (`"you have ${AI.budget} attempts"`), rendered from data.

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

## Build order

1. **A** (control config) — the biggest type-surface change; do it
   first so everything downstream is authored in the new shape. ~10
   test files + 2 fixtures + example migrate mechanically.
2. **C** (`AI.process` + `ProcessContext` + prose-free) — unblocks the
   deterministic example.
3. **B** (exit sources) — `AI.until(eventSource)` + re-admission; needed
   for GitHub Issues.
4. **D** (doctrine + lints) — pure, cheap, locks in the defaults.
5. **E** (the example: Channel-as-code, IssueWork, prose variant) +
   an OrgStress-style live test.
6. Docs: invert the teaching order (Tool → Agent → Effect → `process` →
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
