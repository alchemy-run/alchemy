# Reassessing deterministic orchestration — do we need a workflow DSL?

Design-research report. The problem (owner, verbatim): *"I am not sure how a
user would write deterministic control code to use these things. It looks like
maybe a bit too much is reliant on an LLM making every decision. We should look
into flue, eve, mastra, etc. which all have the ability to write deterministic
workflows that trigger agents."* Concretely: the org example's `Channel` is an
LLM Process whose charter decides who responds, relays replies via tools, and
resolves — **every routing decision is a model call**, ~4–8 coordinator turns
per Post at `iterations: 8`, all to do something a `switch` statement could do.

Sources: the prior framework reports (`flue.md`, `eve.md`, `mastra.md`,
`effect-ai-mapping-*.md`), the main design (§2.5/§2.8/§2.9), `src/AI/*`
(`Process.ts`, `Kernel.ts`, `KernelMemory.ts`, `TraceStore.ts`), and
`examples/agent-chat-web/src/{org,server}.ts`.

---

## 1. How the surveyed systems write deterministic workflows that call agents

| System | Workflow primitive | How agents are called | Where prose lives | Fan-out / join / steering |
|---|---|---|---|---|
| **Mastra** | `createWorkflow` + `createStep`, chained with `.then/.parallel/.branch/.foreach/.dowhile` — a typed step graph with snapshot durability. Notably, *their own agent loop is implemented as one of these workflows* (mastra.md §overview). | An agent **is a step** (`createStep(agent)`); its typed output feeds the next step's `inputData`. | Only inside agent `instructions`; the workflow itself is pure config/code. | `.parallel`/`.foreach {concurrency}`; suspend/resume snapshots for HITL; signals drained between iterations. |
| **Flue (pi)** | `workflows/<name>.ts` — **plain TypeScript functions**, finite invocations, explicitly *not* durable ("a retry creates a new invocation", flue.md §2.5). | `dispatch()` / `session.prompt()` against durable agent submissions; the durability lives in the *agent submission*, not the workflow. | Agent definitions only. | Plain JS concurrency; scheduling is userland `croner`; no framework join. |
| **Eve** | The durable engine is workflow-shaped internally (turn-workflows, hooks), but user-facing deterministic orchestration is (a) TypeScript around sessions and (b) the **Workflow tool** — a pipeline executed *inside one durable step*; plus QuickJS "dynamic workflows" (model-authored JS, allowlist-bridged) as the escape hatch in the other direction. | Subagent calls with budget leases; workflow-tool pipelines call `tools.<name>` only. | Agent markdown. | Fan-out size drives budget splitting; HITL = parked hooks. |
| **Temporal-style** (also Inngest AgentKit, LangGraph) | Deterministic replayable workflow code (Temporal), a code-based **router function** over network state that picks the next agent (AgentKit — the router is *optionally* an agent, default is code), or a typed state-graph whose nodes are functions and whose conditional edges are code (LangGraph). | Agents are activities / nodes / functions returning typed results into shared state. | Node/agent internals. | Language-level or graph-level parallelism (LangGraph `Send`); signals/interrupts for steering. |

**The convergent shape.** In every system, the deterministic workflow is
*ordinary code* (or a graph so thin it's ordinary code with checkpoints), agents
are called like typed async functions, results flow as values, prose exists
only inside agent nodes, and fan-out/join is the host language's concurrency.
Nobody invented a prose coordinator; Mastra's LLM-routed "networks" are their
*least* trusted feature (their own docs: "The LLM might think the task is
complete when it isn't" — mastra.md §insight). The only genuinely load-bearing
DSL feature anywhere is **durability of the step graph** (Mastra snapshots,
Temporal replay) — and Flue ships without even that.

## 2. What alchemy already has

Everything in the table's middle columns already exists, and in a stronger,
typed form:

- **Agents as typed async functions.** `ProcessService.dispatch(item): Effect<Out, Err>`
  *is* the "agent as step" primitive — `Out` derived from the halt schema,
  `Err` typed (`BudgetExceeded | Refused`). `sage.dispatch(post)` from plain
  `Effect.gen` code is exactly Mastra's `createStep(agent)` without the wrapper.
- **The workflow language is Effect itself.** `.then` → `yield*`; `.parallel` →
  `Effect.all({ concurrency })`; `.branch` → `if`/`Match`; `.dowhile` →
  `Effect.repeat`/`Effect.iterate`; racing the fast agent against the thorough
  one → `Effect.race`; retry/timeout → `Schedule`. Every combinator the DSLs
  hand-rolled is already here with laws and interruption semantics.
- **The extension point is already documented.** `Kernel.ts` on `AI.layer`:
  *"an Agent/Process class is an ordinary `Context.Service` tag, so
  `Layer.effect(Engineer, impl)` works — the kernel default is a convenience,
  not a privilege."* A term tag can be implemented by hand today.
- **Steering/interruption verbs** exist on the same service, and triggers
  (`AI.on`/`each`/`every` + `EventBus`/`EventChannelService`) already unify as
  `Stream<In>` at interpretation time.
- **The doctrine already points here.** §2.9: "occurrence is deterministic,
  judgment is fuzzy"; §2.8: fan-out "is `Effect.forEach` + `concurrency` around
  pattern 1... it gets no vocabulary"; the check slot already takes
  `MachineCheck` arrows. The design has consistently *refused* a workflow DSL
  — what it never did is show the user how to write the deterministic side.

**Verdict on the hypothesis: confirmed.** Effect IS the deterministic workflow
language. We do not need `AI.workflow` graph combinators — a Mastra-style DSL
would be a strictly worse Effect. What's missing is *packaging*: today, writing
`Layer.effect(Engineering, …)` by hand means also hand-rolling everything
`kernel.interpret` gives you for free.

## 3. The gap (what a hand-written ProcessService costs today)

1. **Five verbs of boilerplate.** The user has a function `In → Effect<Out, Err>`
   but must implement `dispatch`, `send`, `run`, `steer`, `interrupt` — the
   serial mailbox, the `dispatch = send + await` identity, the trigger-lift
   (`run()` subscribing the term's `AI.on` sources through
   `EventBus`/channels), interrupt-as-fiber-authority. All of it lives inside
   `KernelMemory.ts` and none of it is exported for reuse.
2. **No Trace, no UI.** The org UI renders timelines as Trace projections
   (`message.posted` / `tool.completed` rows). A hand-written process emits no
   `KernelEvent`s, so channels it coordinates are invisible — the deterministic
   Channel would *work* but the workspace would show nothing. There is no
   public "emit onto my ring's Trace" surface; `TraceStore` is a kernel seam.
3. **No prose-free term shape.** A deterministic process still wants a *term*
   (for the tag, `In`/`Out`/`Err` derivation from trigger/halt refs, topology,
   and `meta`), but `AI.Process` demands a charter template that would never be
   rendered. It works with a stub template today; it should be a supported,
   lintable form ("this term is implemented by hand — no charter required, no
   model interpreted").
4. **No documented pattern.** Nothing in the design or examples shows
   "coordinator = code, judgment = a leaf agent." The org example teaches the
   opposite: the *first* thing a new user sees is an LLM doing `if/else`.

## 4. The recommended pattern — the deterministic Channel

The term keeps its refs (they type the handler and wire triggers/topology);
the charter prose is replaced by an implementation function. One proposed
helper does the lifting: **`AI.process(term, handler)`** builds the full
`ProcessService` (mailbox, trigger-lift, steer queue, interrupt, Trace
emission) from `handler: (item, ctx) => Effect<Out, Err>`.

```ts
// org.ts — the term: shape only, no charter prose, no model
export class Engineering extends AI.Process<Engineering>()("engineering")`
${AI.on(ChannelMessage)}
${AI.until(S.String)`the Post is resolved`}` {}

// engineering.ts — the implementation: plain Effect, zero LLM in the routing path
export const EngineeringLive = Layer.effect(
  Engineering,
  Effect.gen(function* () {
    const sage = yield* Sage;
    const scout = yield* Scout;

    return yield* AI.process(Engineering, (post, ctx) =>
      Effect.gen(function* () {
        // 1. route — deterministic; see below for the fuzzy variant
        const members =
          post.text.length > 400 || /architect|trade-?off|design/i.test(post.text)
            ? [{ name: "Sage", svc: sage }]
            : /urgent|asap/i.test(post.text)
              ? [{ name: "Sage", svc: sage }, { name: "Scout", svc: scout }]
              : [{ name: "Scout", svc: scout }];

        // 2. fan-out — Effect.all IS the parallel dispatch
        const replies = yield* Effect.all(
          members.map((m) =>
            m.svc.dispatch(post).pipe(Effect.map((text) => ({ ...m, text }))),
          ),
          { concurrency: "unbounded" },
        );

        // 3. relay — Trace rows via ctx, not a PostReply tool + model turn
        yield* Effect.forEach(replies, (r) => ctx.post(r.name, r.text));

        // 4. resolve — the return value IS the resolution (Out = string)
        return `answered by ${members.map((m) => m.name).join(", ")}`;
      }),
    );
  }),
);
```

Where the prose charter needed ~25 lines of instructions plus a kind scaffold
plus `iterations: 8` of coordinator model calls per Post, this is ~30 lines of
code, **zero coordination tokens**, unit-testable with stub `Sage`/`Scout`
layers, and impossible to "forget to relay" — the failure modes the charter
had to legislate against ("you NEVER write prose into the thread") don't exist.
The server wiring is unchanged: same tag, same `ProcessService`, ChatSessions
and topology don't know the difference.

**Which decisions genuinely benefit from LLM judgment?** Exactly one in this
example: *fuzzy routing* — "is this deep, quick, or both?" The §2.9 shape
(deterministic occurrence, fuzzy judgment, positionally invoked) applies in
miniature: make the judgment a **leaf the deterministic code calls**, never
the loop that calls the deterministic code:

```ts
const RouteDecision = S.Struct({
  members: S.Array(S.Literals(["Sage", "Scout"])),
  thread: S.Boolean,
});
// one cheap structured-output call, invoked BY code, bounded by construction
const route = (post: Post) =>
  LanguageModel.generateObject({
    prompt: `Channel routing. Sage = depth, Scout = speed. Message: ${post.text}`,
    schema: RouteDecision,
  }).pipe(
    Effect.map((r) => r.value),
    Effect.orElseSucceed(() => ({ members: ["Scout"], thread: false })), // typed fallback
  );
```

One model call (a classifier, not a coordinator), a schema the code can trust,
a deterministic fallback when the judge fails — Mastra's networks and Inngest's
default-code-router converged on the same split. A tiny `Router` *Agent* term
works too when the judgment needs tools; `generateObject` under the ring's
model Layer is the cheaper default. This inverts the example's current shape
without losing anything the LLM was actually good at: the room-simulation
*judgments* survive as leaves; the room-simulation *mechanics* become code.

**When is the prose coordinator still right?** When the coordination itself is
open-ended — the set of actions isn't enumerable in advance (the `#support`
triage room that might file issues, escalate, or ask clarifying questions).
The two forms compose: a prose Channel can delegate to a deterministic Process
and vice versa, because both are just tags resolving to `ProcessService`. That
is the real answer to "Channel could be an API that deterministically triggers
a Thread process": yes — and Thread stays an LLM Process (`AI.until`) while
Channel becomes code, each on the side of the determinism line it belongs.

## 5. Changes required (ordered, each small)

1. **`AI.process(term, handler)`** (~150 lines, extracted from `KernelMemory`'s
   ring): lifts `(item: In, ctx: ProcessContext) => Effect<Out, Err>` into the
   five verbs — serial mailbox (honoring `AI.concurrency`), `dispatch = send +
   await`, `run()` = trigger-lift over the term's `AI.on/each/every` refs via
   the existing `EventBus`/channel subscribe path, `interrupt` = fiber
   interruption + typed settlement, `steer` = a queue exposed on `ctx`.
   `In`/`Out`/`Err` come from the term's refs, so the handler is fully typed.
2. **`ProcessContext`**: `emit(event)` (Trace rows on this ring, through the
   `TraceStore` seam so timelines/inspector render identically), `post(author,
   text)` sugar for `message.posted`, `steers: Stream<unknown>`, plus the run's
   ids for provenance. This closes gap 2 and is useful beyond this feature
   (any custom harness code wants it).
3. **Prose-free term form**: bless `AI.Process` terms whose template is
   empty/refs-only when the tag is hand-implemented; lint the *combination*
   (charter-less term + `AI.layer(term)` = error "no charter to interpret";
   charter-less term + custom Layer = fine). Topology reports them (subkind or
   `kind: "process"` with `impl: "code"`) so the sidebar still renders.
4. **Docs + example**: a "Deterministic processes" section in the design (the
   §2.9 determinism line extended one level up: *coordination is code by
   default; prose coordinators are for open-ended rooms*), and the org example
   grows a second channel implemented as code side-by-side with the prose one
   — the contrast is the tutorial.
5. **Non-goals, explicitly**: no `AI.workflow` step-graph DSL, no `.then/
   .parallel` combinators, no new term kinds for fan-out (§2.8 already ruled),
   no durable-workflow engine now — durability of deterministic orchestration
   arrives with the Phase-3 harness ladder (the handler runs on a ring; the
   ring's admission ledger is the durability boundary, same as Flue's
   "durable submissions, plain-TS workflows" split, which production evidence
   says is enough to ship).

The one-sentence version: **agents became typed functions the moment
`dispatch` got its types — now make it obvious, cheap, and visible (Trace) to
call them from plain Effect, and reserve the LLM for the judgments, not the
plumbing.**
