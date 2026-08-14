# Cross-reference: DeepSeek Harness (dsh)

_Reviewed 2026-08-14 against [spec.md](./spec.md) and the shipped
`packages/alchemy/src/AI` implementation. Source:
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
("Everything is a Plugin", built on Cordis — "A Programming Paradigm
for Spatiotemporal Composability")._

## Why this review mattered

dsh is the strongest independent validation of our architecture to
date: a 67k-star harness that arrived — separately — at almost every
load-bearing decision in the charter spec, then diverged in ways that
are instructive on both sides. This document records the convergences
(what we no longer need to second-guess), the harvest (what we
adopted, now shipped), and the rejections (what dsh needs that our
substrate makes unnecessary).

## Cordis is a dynamic, untyped Layer system

Their framework's pillars map one-to-one onto Effect:

| Cordis | Effect |
|---|---|
| "registrations are reversible effects that unwind on unload" | `Scope` finalizers |
| `inject` (plugin waits `PENDING` until services exist) | the `R` channel |
| `isolate` realms (two subtrees, two provider instances) | `Layer.fresh` |
| typed events via declaration merging + `@mode` tags | typed service methods |
| runtime invariant registry (`ctx.invariants`) | `tsc` |
| generated event/seam catalogs, CI-checked | the type system, plus codegen we could add |

Their "spatiotemporal composability" paper formalizes what Layers give
us statically. The trade: they get hot-reload and YAML-patchable
composition of a *running* tree (`dsh --dump-config` prints the whole
product as replaceable rows); we get compile-time proof that the
composition is coherent. Both are "everything is a plugin" — even
their agent loop is a config row, as our `Driver` is a Layer.

## Convergences (independent, therefore evidence)

- **Thin loop + capability seams.** Their seam doctrine — Service
  Definition + Provider + Consumer, "one role alone is not a seam" —
  is our `Context.Service` + Layer split. Both cores stay small;
  compaction, sandboxing, spill, subagents are all optional seams on
  both sides.
- **The delivery verbs.** Their `followup` / `steer` / `inject` are
  our `send` / `steer` / `send({ wake: false })` — down to the exact
  semantic that injected context lands durably *without waking*; a
  parked session stays parked until something else wakes it.
- **Tool failures never kill the turn.** "Unknown and throwing tools
  both become structured errors, so the call fails without ending the
  turn" — our model-visible-failure lane (§11b), verbatim.
- **Execution-world portability.** Their E2B insight: containers and
  microVMs are *sibling implementations of whole capability seams*,
  not providers of a sandbox wrapper — swap `ctx.fs` + `ctx.subprocess`
  and bash/PTY/LSP move with zero forks. Exactly our `Sandbox` seam
  (exec + files as one service; `SandboxLocal` / container guest).
- **Code mode as one wire tool** whose nested calls re-enter the full
  pipeline ≈ our `CodeMode*` engines over `Eval`. Skills as loadable
  teachings, continuable subagents, "fresh agent per round, workspace
  as memory" (their Ralph) — all present in the spec or the org app.
- **Event-sourced session truth.** Their append-only `SessionEvent`
  log with `deriveMessages()` as a projection ≈ our `ThreadStorage`
  thread + observation log with `toUIMessages` at the edge.

## The harvest — adopted and shipped (2026-08-14)

1. **"Model-visible means logged" → the `stance` observation.** dsh
   logs the *assembled request envelope* (rendered system prompt +
   tool schemas + call config) as durable events, so "every
   conversation request is a pure function of the log", asserted at
   runtime. We shipped the same law: every sampling appends a `stance`
   observation — envelope hash every tick, full snapshot (prose +
   toolkit) only when the hash changes. Any tick is now
   reconstructable from `ThreadStorage` alone. (`EventStream.ts`,
   `DriverCore.compileTick`.)

2. **Union-toolkit + stance masking — pulled forward from §13.**
   dsh treats KV-cache stability as a first-class design constraint
   (every package documents its "KV Cache effect"; `exit_plan_mode`
   never leaves the schema "so transitions add no tool-catalog
   churn"). That evidence promoted our deferred union-toolkit design
   into the engine: the direct wire carries the session's union of
   every tool ever mentioned, in first-mention order; a tool
   unmentioned *this tick* rejects model-visibly. Semantics stay
   mention-is-presence; the payload stops churning on phase flips.
   (`DriverCore.compileTick`; engines own the policy themselves —
   noted in `ToolEngine.ts`.)

3. **Synthesized `interrupted`, never truncation.** dsh closes a
   crashed-mid-turn log with a synthetic `turn/end { interrupted }` —
   the one end-reason no healthy loop emits. Our recovery path now
   appends a typed `interrupted` observation (attempt / maxAttempts)
   beside the model-facing recovery note, instead of overloading an
   `input` row.

4. **Spill as policy, not per-tool code — via the seam we already
   had.** dsh bounds oversized output with a post-execute policy over
   an abstract store (head/tail preview + opaque locator,
   *best-effort*: a spill failure keeps the inline original). Our
   translation needed **no new seam**: `ToolEngine.present` already
   sees every mention with its live handler, so the org's spill net is
   a userland engine layer (`services/alchemy-org/src/lib/Spill.ts`)
   over the existing `ToolOutputStore`. Tools with tailored policies
   (bash per-channel tails, grep caps, readFile paging) keep them; the
   net catches the unbounded (`readDiff` dropped its data-discarding
   60k cutoff). One core enabler: `ToolMention.tool` passes the
   compiled provider tool through so direct-presentation wrappers
   don't reconstruct it.

5. **The approval gate — userland, because tools are Effects.** dsh
   needs a core `ctx.approval` seam because their pipeline is the only
   interception point; ours don't — a dangerous tool gates *itself* by
   yielding an approval service inside its own impl. Shipped as
   `services/alchemy-org/src/services/Approvals.ts` (fail-closed
   one-shot `ask`; only `allowed-once` proceeds; disarmed by default,
   armed via `ORG_APPROVALS=ask`) + UI card; `submit_review` asks
   before posting. Borrowed dsh subtleties: monotonic denial, the
   request references the call rather than restating arguments.

6. **Sandbox denial dialects.** dsh backends ship `denialSignatures`
   vs `runnerFailureRules` and teach the model that a denial is "a
   policy denial, not a bug — do not retry another way". Our
   containment and spawn failures now self-classify (`[policy denial]`
   vs `[sandbox failure] the command never ran`) in
   `Workspace.ts` / `SandboxLocal.ts`.

7. **The compaction design, recorded for §13** (not built — compaction
   remains userland policy by our own doctrine, which dsh confirms by
   shipping theirs as an optional seam): three independent,
   log-replayable pressure valves — (a) spill at result time (shipped,
   above); (b) deterministic tool-result pruning with per-node
   shadow-price events, before any LLM call; (c) summary compaction as
   an ordinary message carrying a surface `replace` op citing the
   shadowed range, bracketed by lock events whose *orphaned start is
   crash evidence*, with tool-call/result pairing preserved across
   boundaries. Model surface and human transcript become two
   projections of one log. Prerequisite: a `TokenMeter` seam anchored
   on real provider usage.

## Rejected — dsh needs these; our substrate doesn't

- **Waterfall/serial event middleware + hook bridges.** Effect
  composition and Layers are our interception points; an event
  middleware system would re-implement the runtime.
- **Profiles / bundles / YAML patch trees.** Our composition is typed
  code; `--dump-config` envy is answered by `tsc` (a generated
  seam/tool catalog doc remains a nice-to-have).
- **Agent presets / scope shadowing / generation-sharing
  (`composeFrom`).** Layer-per-charter gives per-agent capability sets
  without the drift machinery their registry-assembled prompts
  require. Our stance *derives* the toolkit from the prose — the
  capability set and the prompt cannot disagree by construction.
- **Runtime invariant registry.** `tsc`.
- **Frozen tool arguments** — adopted as doctrine (it is already true
  of the engine: nothing rewrites args between the model and the
  handler); no mechanism needed.

## Where we remain ahead

- **Types as the invariant system**: mention-is-presence lifted into
  wire types (renderer coverage is compiler-checked), declared tool
  errors as typed channels.
- **Durability and placement**: dsh is one Node process — sessions in
  memory, persistence behind, schedules honestly "session-local,
  delivery only while live". Parked-durable sessions, DO placement,
  hibernating sockets, and world-event waking are a tier they haven't
  attempted.
- **Infrastructure as capability**: bindings that mint tokens/IAM at
  deploy time and become runtime clients have no dsh analogue.

## Are we better positioned for recursive self-improvement?

Yes, on three axes this review directly strengthened:

1. **The agent can now see its own mind.** The `stance` observation
   closes the biggest introspection gap: before it, not even the
   operator could reconstruct what the model saw on tick N; now the
   log carries the full request envelope. A self-improving agent needs
   exactly this — you cannot debug or improve a stance you cannot
   replay. This is also the substrate for evals (replay a session
   against a changed charter and diff the envelopes).
2. **Behavior edits are safer to make.** Union-toolkit means charter
   phase changes no longer thrash the provider cache; the approval
   gate means the org can hand the agent *dangerous* tools (merge,
   deploy, self-edit) behind a fail-closed human gate rather than
   withholding them entirely. Both lower the cost of iterating on the
   agent's own capabilities.
3. **The improvement loop has a reference design.** dsh's `cordis_*`
   tools (opt-in: `cordis_define` / `cordis_inspect_*` / `cordis_run`)
   are the most complete existing answer to "the agent authors plugins
   into its own live runtime", made safe by reversible effects and
   inspect-before-author tooling. Our equivalent — the Engineer
   editing charter Layers in its own checkout, with hot reload and the
   approval gate on the apply step — is architecturally closer than
   dsh is to *durable* self-improvement, because our sessions survive
   the restart that a self-edit implies. The missing piece dsh points
   at is **self-inspection tools**: let the agent query the live Layer
   graph, seams, and tool schemas before writing against them
   (deferred; see spec §13).

The honest gap in the other direction: dsh's generated,
boot-verified docs (event matrix, seam graph, tool catalog) keep their
architecture description true by construction. Our spec drifts (this
review found kernel/run/`WireMode` vocabulary lagging the code). A
`Layer`-derived seam/tool catalog generator would close that the same
way.
