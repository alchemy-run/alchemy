# Mapping Mastra's loop mechanics onto effect v4 `unstable/ai` — design research

How Mastra's loop-as-workflow, observational memory, goal judging, HITL suspension, and
signals would be implemented on effect v4's unstable AI modules inside the Alchemy AI
kernel (Phase 2 step machine + §2.5 loop runtime, Phase 3 Cloudflare harness).

Everything cited was verified against the sources in this workspace:

- effect v4 `.d.ts` under `node_modules/effect/dist/unstable/ai/` (`LanguageModel`,
  `Tool`, `Toolkit`, `Chat`, `Prompt`, `Response`, `Model`, `Tokenizer`, `AiError`) and
  `node_modules/effect/dist/unstable/workflow/` (`Workflow`, `Activity`,
  `DurableDeferred`) — cited as `file.d.ts:line`.
- Mastra at `.vendor/mastra` (commit `6b51b0c`) — cited as `path:line` relative to that
  repo.
- Alchemy design doc `designs/ai/alchemy-ai-design.md` (§2.2/§2.4/§2.5/§3.2/§9.3) and
  `packages/alchemy/src/AI/*` (Check, Fold, Budget, Halt, Errors, Kernel, Loop, Process).

Headline findings up front:

1. **effect/ai already ships the HITL wire format Mastra had to invent.**
   `Tool.make(..., { needsApproval })` (Tool.d.ts:854), `Response.ToolApprovalRequestPart
   { approvalId, toolCallId }` (Response.d.ts:1164–1178) and
   `Prompt.ToolApprovalResponsePart { approvalId, approved, reason }`
   (Prompt.d.ts:599–612) are callId-keyed by construction — the exact invariant Mastra
   learned by losing parallel suspensions (`tool-call-step.ts:187–193`). Our `Ask` maps
   onto these parts for the approval payload kind; the durable wait itself stays ours.
2. **effect/ai deliberately has no agent loop** — no `stopWhen`, no step hooks, no
   iteration. `LanguageModel.generateText` resolves at most one round of tool calls
   (LanguageModel.d.ts:53–65) and `disableToolCallResolution` (LanguageModel.d.ts:164–172)
   hands even that to us. This is not a gap; it is exactly the seam the §2.4 step machine
   needs. Every place Mastra fights its own workflow engine, we own the driver.
3. **The two things Mastra's OM gets structurally wrong on Node — static-map buffering
   coordination and an in-process mutex — dissolve on our substrate**: sealed-chunk state
   lives in the fold snapshot (serializable StepState) and the Ring DO is single-writer.
4. **No fallback / token-tiered model combinator exists in `Model.d.ts`** — `Model.make`
   (Model.d.ts:104–116) wraps one provider layer. Tiering and fallback are a ~40-line
   hand-rolled `Layer.effect(LanguageModel, …)` (sketch in §5); `Model.captureRequirements`
   (Model.d.ts:39) is the piece that makes composing several models inside one service
   ergonomic.

---

## 1. The Check (goal judge) on effect/ai

### What Mastra does (verified)

`goal-step.ts` runs after every quiescent iteration and:

- skips background-pending, mid-tool-loop, and working-memory-only iterations
  (goal-step.ts:116–122);
- refuses to burn a judge call when an active record is already at/over budget
  (goal-step.ts:146–169);
- resolves a **separate judge model** (goal-step.ts:177–188, 268–275), optional
  **read-only verification tools** (goal-step.ts:281–284), and a judge **memory thread of
  its own** keyed `${threadId}-${goalId}` with `{forkedSubagent, goalJudge,
  parentThreadId}` metadata (goal-step.ts:294–311);
- wraps *everything* judge-related in try/catch so a thrown judge becomes an explicit
  `errored` scorer result rather than an escaped exception that would re-loop forever
  (goal-step.ts:190–378, comment at 196–199);
- decides with explicit precedence (goal-step.ts:396–426):
  `judgeFailed → paused(reason)` › `complete → done` › `budget → paused(resumeHint)` ›
  `waiting → stop auto-loop, record stays active` › `else → isContinued = true` with the
  judge's reason injected as feedback for the next iteration (goal-step.ts:483–492).

### The kernel's boundary invocation

Our `Check` ref (src/AI/Check.ts:32–40) already names the judge positionally. The kernel
invokes it at the §2.5 boundary as a two-phase arrow, entirely on verified effect/ai
surface:

**Verdict type — three model-producible verdicts, one kernel-derived.** Mastra encodes
tri-state in a score plus an `errored` flag; the honest typed version is a `Schema.Union`
the judge model can emit, with `CheckFailed` reified from the judge invocation's *error
channel* — a failed judge cannot have validly produced a verdict, so `CheckFailed` must
not be a schema member the model could hallucinate:

```ts
import * as Schema from "effect/Schema"

export const CheckVerdict = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("GoalMet"),
    /** what the judge verified, not what the worker claimed */
    evidence: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("OffGoal"),
    /** becomes the next iteration's first input */
    feedback: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("Waiting"),
    /** the question the human must answer; run stays active */
    question: Schema.String,
  }),
])

/** kernel-side, never model-side */
export type BoundaryVerdict =
  | typeof CheckVerdict.Type
  | { _tag: "CheckFailed"; reason: string }   // judge errored → park
```

**Invocation.** The Check agent's Stage-A link (design §2.2) resolved its own
`LanguageModel` Layer (the judge's model physics) and its read-only toolkit (e.g.
`BashReadOnly` from `test/AI/fixtures/org/cloudflare/tools.ts`). At the boundary the
kernel drives a bounded verification loop, then extracts the verdict with
`generateObject`:

```ts
import * as Effect from "effect/Effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"

// kernel-internal: grade one iteration's Trace against the halt condition
const runCheck = (args: {
  haltCondition: string          // rendered from the Halt ref's template
  checkInstructions: string      // Check template ?? the judge agent's own template
  traceDigest: Prompt.RawInput   // rendered from the iteration's Trace (Prompt.RawInput, Prompt.d.ts:1330)
  judgeToolkit: Toolkit.WithHandler<JudgeTools>   // read-only physics
  maxJudgeSteps: number
}) =>
  Effect.gen(function* () {
    // Phase 1 — verification: the judge may run its read-only tools.
    // effect/ai resolves ONE round of tool calls per generateText call
    // (LanguageModel.d.ts:53–65); the kernel drives the multi-round loop,
    // bounded by maxJudgeSteps (a judge budget, not the ring's).
    let prompt = Prompt.make(args.traceDigest).pipe(
      Prompt.setSystem(`${args.checkInstructions}\n\nHalt condition:\n${args.haltCondition}`),
    ) // Prompt.setSystem: Prompt.d.ts:1550
    for (let i = 0; i < args.maxJudgeSteps; i++) {
      const res = yield* LanguageModel.generateText({
        prompt,
        toolkit: args.judgeToolkit,          // GenerateTextOptions.toolkit: LanguageModel.d.ts:140
      })
      // fold this round back into the judge's working prompt
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(res.content))
      // Prompt.concat: Prompt.d.ts:1466; fromResponseParts: Prompt.d.ts:1441
      if (res.toolCalls.length === 0) break   // GenerateTextResponse.toolCalls: LanguageModel.d.ts:261
    }
    // Phase 2 — the verdict, structurally typed
    const graded = yield* LanguageModel.generateObject({
      prompt,
      schema: CheckVerdict,
      objectName: "verdict",                  // GenerateObjectOptions: LanguageModel.d.ts:183–193
      toolChoice: "none",                     // LanguageModel.d.ts:156
    })
    return graded.value                       // GenerateObjectResponse.value: LanguageModel.d.ts:305–311
  }).pipe(
    // judge failure is a VERDICT, not an escape — Mastra's purchased lesson
    // (goal-step.ts:196–199, 388–397). AiError is the op's typed error
    // (ExtractError, LanguageModel.d.ts:355–362).
    Effect.catchAll((e: AiError.AiError) =>
      Effect.succeed({ _tag: "CheckFailed" as const, reason: e.message })),
    Effect.provide(judgeModelLayer),          // the Check agent's own Model (see §5)
  )
```

Notes against the exercise's checklist:

- **Judge's own model** — provided as a Layer on the judge invocation only; per §2.4,
  `CallModel` carries the model as per-turn data, so this is the ring policy expressed
  through the Check agent's Layer. No recomposition of the doer's environment.
- **Read-only tools** — the judge's toolkit is a *different Layer implementation of the
  same contracts* (BashReadOnly / the Phase-3 COW overlay), which is our standing
  per-agent physics story; nothing new is needed. `Tool.Readonly` annotation
  (Tool.d.ts:1248) can additionally mark judge tools so a lint can verify the judge
  toolkit is entirely read-only.
- **Judge's own memory thread** — Mastra forks a `goalJudge` thread per
  `(threadId, goalId)` so the judge's deliberation persists across iterations of one run
  (goal-step.ts:294–311). Our mapping: the check agent's invocations write to the same
  ring Trace under a distinct session key derived from `(workItem, "check")`; the check's
  own prior verdicts are then available to it via trace-read at the next boundary. Fold
  scope for the check is separate from the doer's fold — carried in the loop runtime's
  boundary state, not in the doer's carried state.
- **Budget-guard-before-judge** — our budgets are kernel-enforced *pre-call* (Budget.ts
  doc, §2.4 "per-command and transactional"), which subsumes Mastra's defensive
  re-entry guard (goal-step.ts:146–169): a boundary whose remaining budget is zero
  raises `BudgetExceeded` before the judge model is ever called.

### Where the verdict feedback enters

Per §2.5, `OffGoal.feedback` becomes **the next iteration's first input**. Concretely in
the step machine: the boundary emits a durable `IterationFolded`-adjacent event carrying
the verdict, and the next iteration's Stage-B seed prompt is

```ts
Prompt.concat(
  renderedTerm,               // re-supplied from the immutable term (§3.2)
  foldedContext,              // the fold's rendering
  Prompt.make([{ role: "user", content:
    `[check ${runsUsed}/${maxRuns}] Goal not met. Judge feedback: ${feedback}\n` +
    `Continue working toward: ${haltCondition}` }]),
)
```

which is Mastra's continuation message (goal-step.ts:483–492) with two deviations we keep
deliberately: the feedback is a *user* message, not a fake assistant message (Mastra
injects judge feedback as `role: 'assistant'` in `is-task-complete-step.ts:139–163`,
which pollutes the model's own voice), and it is derived from the Trace event rather than
written into a mutable message list.

### Verdict → LoopExit mapping (the §2.5 decision, now concrete)

| verdict | kernel action |
|---|---|
| `CheckFailed` | **park with reason** — the run is retained (fold + work item stay), an `Escalated` KernelEvent carries the reason, no further iterations. Never silently re-loop. Surfaced to `dispatch` callers only if the park times out into policy; otherwise the run waits for a control stimulus (re-dispatch after judge fix). |
| `GoalMet` | halt; `Out` extracted per the halt schema (halt-as-tool's `resolve` payload, graded by this check). |
| budget ceiling (kernel, pre-call) | `BudgetExceeded{limit, used, resumeHint}` (Errors.ts:17–28) — parks resumably per §9.3; interactive rings may surface a continuation `Ask`. |
| `Waiting` | stop the auto-loop, ring stays active: emit `Escalated` with the question (the §8.4 escalation vocabulary); the answer re-enters as a steer. No status change to the run record — mirrors goal-step.ts:406–410. |
| `OffGoal` | continue; feedback seeds the next iteration as above. |

Precedence is *designed* (a total function of the boundary state), not emergent from step
order — the entire point of having one halt decision point (see §7).

---

## 2. Observational memory as a Fold Layer

### What Mastra does (verified)

- Defaults: Observer + Reflector both `google/gemini-2.5-flash`; observation threshold
  30k message-tokens; reflection threshold 40k observation-tokens; `bufferTokens: 0.2`
  (Observer runs in the background every 20% of the threshold), `bufferActivation: 0.8`
  (activation retains 20%) (constants.ts:4–41).
- Per-step `step.prepare()` checks thresholds and either activates buffered chunks or
  triggers observation (processor.ts:265–290). Buffer-interval crossing is computed from
  `(currentTokens, lastBoundary)` with an interval-halving ramp near the threshold
  (buffering-coordinator.ts:108–144).
- Buffering state is **static process-wide maps** plus an OM record row
  (buffering-coordinator.ts:24–42) and cross-instance coordination is an in-process
  mutex with a documented "distributed deployments must accept eventual consistency"
  caveat (mastra.md §2).
- Activation is an instant swap at a chunk boundary chosen to land at the retention
  floor (thresholds.ts:93–186); forced activation on idle TTL (`activateAfterIdle`,
  types.ts:163) and on actor **provider/model change** (`activateOnProviderChange`,
  types.ts:169) because the prompt cache is invalidated anyway.
- The actor sees one system message **per cache-stable chunk** plus a continuation-hint
  user message (processor.ts:65–99, constants.ts:48–54); sealed/activated lifecycle is
  journaled as data-parts *in the transcript itself*; chunk sealing rotates the response
  messageId to keep caches stable (processor.ts:239–242, 255–258).
- Drillback: observation groups carry `startId:endId` ranges into the raw messages and a
  `recall` tool pages through them at low/high detail (constants.ts:81–121,
  om-tools.ts:51, 169).

### The fold-seam implementation outline

`AI.fold` (src/AI/Fold.ts) is the positional home; the harness Layer is
`Cloudflare.AI.ObservationalMemory` (design §3.2 Memory Layers), an implementation of the
`ContextPolicy` seam. The mechanics map one-to-one, with the state relocated:

**1. Sealed-chunk state lives in the fold snapshot, not static maps.** The carried state
(what `fold: (carried, Trace) → carried'` threads) is a serializable struct:

```ts
interface OmFoldState {
  readonly v: 1
  /** active observations, chunked cache-stably; rendered 1 system msg per chunk */
  readonly active: ReadonlyArray<{
    readonly chunkId: string            // deterministic: (session, cycleOrdinal)
    readonly observations: string       // the XML-tagged block
    readonly covers: { fromSeq: number; toSeq: number }  // Trace range → recall drillback
    readonly tokens: number
  }>
  /** buffered (sealed but not yet activated) chunks — Mastra's BufferedObservationChunk */
  readonly sealed: ReadonlyArray<{
    readonly chunkId: string
    readonly observations: string
    readonly covers: { fromSeq: number; toSeq: number }
    readonly messageTokens: number      // what activation would remove
  }>
  /** replaces BufferingCoordinator.lastBufferedBoundary / lastBufferedAtTime */
  readonly lastBufferedAtTokens: number
  readonly observedThroughSeq: number   // the Trace cursor (replaces lastObservedAt)
  /** provider-change detection input (Mastra types.ts:169) */
  readonly actorModel: { provider: string; model: string }
  readonly pendingTokens: number
}
```

Everything Mastra keeps in `BufferingCoordinator`'s statics and the OM record row is a
field here — it survives `structuredClone`, checkpoints with the fold (the §3.2 rule
"the persisted step result *is* the folded state"), and needs no mutex because the Ring
DO is single-writer (§9.3's scheduler-CAS observation, applied to memory).

**2. Background Observer invocations between boundaries — Effect fibers.** At each
boundary the fold Layer runs a pure trigger check (the interval-crossing function is
`buffering-coordinator.ts:108–144` reimplemented over `OmFoldState` — ~15 lines, no
maps), and if crossed, forks the Observer:

```ts
// inside the harness's boundary step (Stage C), Scope = the run's scope
const maybeBuffer = Effect.gen(function* () {
  if (!crossedBufferInterval(state)) return state
  const chunkId = deterministicChunkId(session, state.sealed.length + state.active.length)
  // journal the start marker FIRST — crash-mid-observation is then replayable
  yield* emit(omEvent("om.buffer.start", { chunkId, fromSeq, toSeq }))
  yield* Effect.forkIn(runScope)(
    observeChunk(traceSlice(fromSeq, toSeq)).pipe(
      // Observer = LanguageModel.generateText under the CHEAP model Layer (§5)
      Effect.flatMap((observations) =>
        emit(omEvent("om.buffer.sealed", { chunkId, observations, messageTokens }))),
      Effect.catchAll((e) => emit(omEvent("om.buffer.failed", { chunkId, reason: e.message }))),
    ),
  )
  return { ...state, lastBufferedAtTokens: currentTokens }
})
```

The fiber's *result is an event, not a state write*: the sealed chunk enters
`OmFoldState.sealed` when the **next boundary** folds the `om.buffer.sealed` event from
the Trace. This keeps `step` pure (the fiber is interpreter-side), makes the transcript
its own journal exactly like Mastra's `data-om-*` markers (mastra.md insight 7 → design
§2.3 "one representation"), and means a crash between boundaries loses only an
in-flight Observer call — the `om.buffer.start` marker without a matching `sealed` is the
recovery signal to re-run or skip (same recovery classification style as Flue's).

On the DO-reducer tier, "background fiber" concretizes as: the boundary *spawns* the
Observer call as a work item on the ring's own inbox (`(state, stimulus) → [state',
spawns]`), and the sealed event arrives as a stimulus. Same shape, different physics —
which is the point of the seam.

**3. Activation is a boundary operation.** At each boundary, after folding sealed
events, the Layer checks the three triggers and swaps atomically:

```ts
type ActivationTrigger = "threshold" | "ttl" | "provider_change"   // Mastra types.ts:748

const maybeActivate = (state: OmFoldState, boundary: BoundaryCtx) => {
  const trigger: ActivationTrigger | undefined =
    state.pendingTokens >= threshold ? "threshold"
    : boundary.idleFor >= activateAfterIdle ? "ttl"                 // DO alarm supplies idleFor
    : boundary.actorModel.provider !== state.actorModel.provider
      || boundary.actorModel.model !== state.actorModel.model ? "provider_change"
    : undefined
  if (!trigger) return state
  const boundary_ = pickChunkBoundary(state.sealed, retentionFloor)  // thresholds.ts:115–186 logic, pure
  // emit om.activation { trigger, chunkIds } — durable, model-visible via next render
  return activate(state, boundary_, trigger)
}
```

`provider_change` detection uses `Model.ProviderName` / `Model.ModelName`
(Model.d.ts:54, 69) — every `Model.make` layer provides them, so the boundary reads the
actor's current provider from context and compares with `state.actorModel`. This also
lands design amendment §0.1/§1.6: the render-cache key is `(provider, model,
promptHash)`.

Idle-TTL activation belongs to the harness (a DO alarm per ring), not the step machine —
observation of the ring (`AI.observe`) must NOT reset it, per the §3.2 Sandbox rule that
observation never counts as activity.

**4. Rendering — the fold pipeline.** `fold → render → markCacheBoundaries → CallModel`
(§3.2) with OM's placement rules: one `SystemMessage` per active chunk
(Prompt.d.ts:862–907; append new chunks only at message boundaries), then the
continuation-hint user message (constants.ts:48–54 verbatim is a good starting asset),
then unobserved raw messages reconstructed from the Trace after `observedThroughSeq`.
Because the rendered term is re-supplied outside ContextPolicy's jurisdiction (§3.2),
the OM Layer never touches the charter/guardrails — Mastra needs prompt-injection
processors for that; we get it by construction.

**5. The `recall` drillback tool is an ordinary Tool over the Trace.** Observation chunks
carry `covers: {fromSeq, toSeq}` — Trace cursors, not message ids. The tool:

```ts
import * as Tool from "effect/unstable/ai/Tool"

const Recall = Tool.make("recall", {                       // Tool.make: Tool.d.ts:810
  description: "Page through the raw events an observation chunk was derived from",
  parameters: Schema.Struct({
    fromSeq: Schema.Number, toSeq: Schema.Number,
    page: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.Literals(["low", "high"])),
  }),
  success: Schema.Struct({ events: Schema.Array(Schema.Unknown), hasNextPage: Schema.Boolean }),
})
// handler = a pure storage read over kernel.trace(ring, after) (src/AI/Kernel.ts:113–117)
// provided via Toolkit.toLayer (Toolkit.d.ts:60–64); grants NOTHING beyond trace access,
// i.e. it is the tool-shaped face of AI.observe — same non-capability.
```

Because trace reads neither wake the ring nor reset keepalives (§2.1), recall is free.
The low/high-detail + `truncated → drill with partIndex` protocol from
constants.ts:81–121 is worth adopting verbatim as the tool description — it is prompt
lore Mastra has already debugged.

**What this resolves:** the tension between "fold at every boundary" and fold-LLM
latency (mastra.md insight 5) — the boundary only *activates*; observation happened in
the background. `blockAfter` (synchronous observation as last resort,
thresholds.ts:74–86) maps to a boundary that finds `pendingTokens > blockAfter` with no
sealed chunks and runs the Observer inline — the degraded path, journaled with the same
markers.

---

## 3. HITL suspension keyed by toolCallId

### The mapping table

| Mastra (verified) | effect/ai (verified) | Alchemy kernel |
|---|---|---|
| `requireApproval: boolean \| NeedsApprovalFn` on `createTool` (mastra.md §3) | `needsApproval: NeedsApproval<Params>` on `Tool.make` (Tool.d.ts:133, 854); the dynamic fn receives `{ toolCallId, messages }` (Tool.d.ts:104–113) | policy lives in the tool Layer / `ToolInterceptor` seam; the *charter* never says "approval" |
| stream closes with pending approval persisted per-`toolCallId` in assistant-message metadata (tool-call-step.ts:152–225) | model output contains `Response.ToolApprovalRequestPart { approvalId, toolCallId }` (Response.d.ts:1164–1178); the call is **not executed** | step machine emits `Ask{ kind: "approval", callId, approvalId, payload }`; pending row in the admission ledger keyed by `callId`; Trace event pair `ToolRequested` → `Escalated` |
| resume via `approveToolCall({runId})` / `declineToolCall` | caller appends `Prompt.ToolApprovalResponsePart { approvalId, approved, reason? }` (Prompt.d.ts:599–612); next `generateText` pre-resolves approved calls and strips resolved artifacts (LanguageModel.js:385–490, 613–660) | `AskAnswer` feedback correlated by `callId`; answer = verdict + optional amendment (§9.3); the response part is written into the Trace-derived prompt by repair-on-read |
| declined persists as `state: 'output-denied'` the model sees (llm-mapping-step.ts:473–489) | `approved: false, reason` response part → framework synthesizes the denial the model sees | typed `denied` ToolResult per the pairing invariant — denial is information, not absence |
| tool-initiated `suspend(payload)` shaped by `suspendSchema`, resumed with `resumeSchema` data | **no analogue** — effect/ai tools have parameters/success/failure schemas only (Tool.d.ts:167–232) | an `Ask` payload kind: the tool handler issues `Ask{ kind: "question", schema: AnswerSchema, payload }`; suspendSchema ≡ the Ask payload schema, resumeSchema ≡ the answer schema. One park protocol (§9.3), no per-tool suspension machinery |
| indefinite waits = suspended workflow snapshot row | — | Ring-DO pending row (reducer tier) / `step.waitForEvent` (Workflow tier) / `DurableDeferred.make` + `token` + `succeed/fail` (DurableDeferred.d.ts:57, 183, 253–314) if Stage C rides `effect/unstable/workflow` |

### The callId-keyed bookkeeping rule — confirmed, and stronger

Mastra's fix-comment is explicit: keying by `toolName` collapsed two parallel calls to
the same tool and lost one suspension irrecoverably
(`AGENT_RESUME_NO_SNAPSHOT_FOUND`, tool-call-step.ts:187–193); their remove-path still
carries a `toolName` fallback for legacy rows (tool-call-step.ts:239–251) — permanent
scar tissue. effect/ai's wire format makes the rule structural: every approval flow has
its own `approvalId` referencing its own `toolCallId` (Prompt.d.ts:689–698); there is no
name-keyed map anywhere to get wrong. Our obligation (already in §2.4) stays: *all*
pending-call bookkeeping — ledger rows, Trace event ids, `AskAnswer` correlation — keys
on `callId`; the property test "two parallel identical tool calls suspend and both
resume" goes in the step-machine conformance suite.

One deviation from Mastra worth keeping: they persist pending approvals *inside message
metadata* (a second representation of run state, mutated in place with a
shared-object-aliasing trick to survive parallel writers — tool-call-step.ts:170–186).
We persist the pending ask as (a) the durable Trace event and (b) a coordination-plane
ledger row; anything message-shaped is derived by repair-on-read. No mutable metadata,
no aliasing tricks, no lost-write hazard.

### The sequential-degradation rule as a kernel obligation

Mastra forces tool-call `foreach` concurrency to 1 whenever **any approval-capable or
suspendable tool is in the step's active toolset — even if not called**, recomputed per
step from the active set rather than the called set
(agentic-execution/index.ts:114–133, comment at 118–123).

Kernel obligation, stated for §2.4: *at Stage-A link time (and again whenever the active
toolset changes mid-run), if any tool in the toolkit satisfies `needsApproval` or is
Ask-capable (human-class Layer), the turn driver caps tool resolution at `concurrency:
1`* — the knob exists directly on the call
(`GenerateTextOptions.concurrency`, LanguageModel.d.ts:162), or is moot when the kernel
resolves calls itself under `disableToolCallResolution: true` (LanguageModel.d.ts:164–172),
which is where Stage B is headed anyway.

Why adopt sequential rather than support concurrent suspensions: our callId-keyed ledger
*could* park several asks at once (unlike Mastra's metadata scheme), but concurrent
pending asks reorder answers against the pairing invariant's deterministic repair and
make the "unrelated input during a pending ask is held" rule (§9.3) ambiguous about
*which* ask input correlates to. Sequential is the conformance floor; concurrent asks
are a later, explicitly-tested relaxation. `AI.concurrency` (Budget.ts:51–64) is
loop-level fan-out and is unaffected — the rule is per-turn tool resolution.

---

## 4. Signals → steer/admission

### What Mastra does (verified)

- Signal categories `user | state | reactive | notification` (signals.ts:9); a signal is
  a first-class transcript row (`role: 'signal'`, signals.ts:448–495) with three
  projections: DB message, LLM message (XML-wrapped with attributes,
  signals.ts:185–193, 399–428), and transient data-part (signals.ts:430–446).
- Pending signals drain **between iterations only**: the drain step marks the response
  message boundary, rotates the messageId, appends signals, and forces
  `isContinued = true` (signal-drain-step.ts:23–52); the same drain re-runs in the
  `dowhile` predicate so signals that arrive after the last step still trigger one more
  iteration (agentic-loop/index.ts:96–115).
- Schedules carry `ifActive`/`ifIdle` delivery policies (queue vs drop vs interrupt)
  resolved into signal attributes (signals.ts:524–534; mastra.md §6).

### Mapping onto the admission ledger

§2.5 already has the load-bearing structure: *one ordered, idempotent admission inbox*
for triggers + steers + controls, drained at the boundary, promotion resets the step
allowance. The category mapping:

| Mastra signal | Alchemy admission kind |
|---|---|
| `user` (interjection into a running turn) | **steer** — promoted at the next boundary as `Steered` feedback (§2.4); under `AI.concurrency > 1`, keyed by the work item's world identity |
| `notification` (background task finished, PR activity on subscribed repo) | **work** when it targets an idle ring (an ordinary trigger stimulus — GitHub events already enter this way, design §3.1 `events.ts`); **steer** when it targets a specific active run (fork-completion re-entering, §9.3) |
| `reactive` / `system-reminder` (goal feedback, OM continuation hints) | not admissions at all — these are **boundary-generated inputs** (check feedback §1, fold rendering §2). Mastra routes kernel-generated feedback through the same signal machinery as external input; we should not: kernel feedback has no delivery-id, no dedupe question, no policy — it is just the next iteration's seed |
| `state` (cache-keyed snapshot/delta lane, `computeStateSignal`) | **no analogue, deliberately** — this is the 9-hook accretion pattern (§9.5). The need it serves (ambient state the model should see fresh each turn) is fold-visible ring state rendered by the fold Layer |
| cancel / budget edit | **control** — already specified: a stimulus through the same inbox, never a second plane (§3.1) |

**Boundary drain order** — theirs and ours agree, and the agreement is worth recording:
Mastra drains signals *before* isTaskComplete/goal, and both judges skip when the drain
set `isContinued` (is-task-complete-step.ts:52, goal-step.ts:116). Our §2.5 order (drain
steers → check) plus the amendment in §6 below ("check only grades quiescent
boundaries") reproduces this exactly.

**messageId rotation → cache-boundary marking.** Mastra rotates the response messageId
so the pre-signal prefix stays cache-stable (signal-drain-step.ts:31–32). In effect/ai
terms the prompt is immutable data — a drained steer is `Prompt.concat(prefix,
Prompt.make([userMessage]))` (Prompt.d.ts:1466, 1377); the prefix bytes are untouched by
construction, and the fold pipeline's `markCacheBoundaries` step (§3.2) owns
provider-specific cache-point placement. Rotation is a mutable-message-list workaround
we do not inherit; what we *do* inherit is the rule it serves: **steers append at
message boundaries, never rewrite history.**

**What their design adds that ours lacks:** per-trigger **delivery policy**. Ours says
steers are "promoted at the next boundary" but nothing lets a trigger declare
interrupt-vs-queue-vs-drop-if-active semantics (a cron ring probably wants
`ifActive: drop`; a human interjection wants `ifActive: queue`; an incident page wants
`ifActive: interrupt`). Recommendation (consistent with §9.3's "delivery policy owned by
the harness"): a `delivery?: { ifActive: "queue" | "interrupt" | "drop"; ifIdle: "work" |
"drop" }` attribute on the **Router seam's** EventSource→ring mapping
(Cloudflare.AI.Router, §3.2) — harness config, not a term; `interrupt` compiles to a
control admission (the existing `interrupt` verb) followed by re-admission of the
stimulus. No new term kinds, no charter surface.

---

## 5. Model routing — fallback arrays and token-tiered models as Layer composition

### What Model.d.ts actually offers (verified — and what it doesn't)

- `Model.make(provider, modelName, layer)` → `Model<Provider, Provides, Requires>`
  which **is a Layer** (`extends Layer.Layer<Provides | ProviderName | ModelName, never,
  Requires>`, Model.d.ts:30–40) additionally providing the `ProviderName`/`ModelName`
  string tags (Model.d.ts:54, 69).
- `model.captureRequirements: Effect<Layer<Provides | ProviderName | ModelName>, never,
  Requires>` (Model.d.ts:39) — closes over the current context so a Model can be used
  *inside* another service's construction.
- **There is no fallback combinator, no tiering, no model array anywhere in the module.**
  Mastra's fallback arrays and `ModelByInputTokens` (model-by-input-tokens.ts:49–68 —
  sorted `upTo` thresholds, error past the largest) have no counterpart; they are ours to
  build — and Layer composition is the right shape for them because `LanguageModel` is
  just a `Context.Service` with three methods (LanguageModel.d.ts:49–86).

### Sketch: a tiered + fallback `LanguageModel` Layer

```ts
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Model from "effect/unstable/ai/Model"
import * as Tokenizer from "effect/unstable/ai/Tokenizer"
import * as Prompt from "effect/unstable/ai/Prompt"

/** ModelByInputTokens as a Layer: route each call by prompt token count. */
export const tieredModel = (tiers: ReadonlyArray<{
  upTo: number
  model: Model.Model<string, LanguageModel.LanguageModel, never>
}>): Layer.Layer<LanguageModel.LanguageModel, never, Tokenizer.Tokenizer> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const tokenizer = yield* Tokenizer.Tokenizer          // Tokenizer.d.ts:47
      // build each tier's service once, at Layer construction
      const services = yield* Effect.forEach(tiers, (t) =>
        Effect.gen(function* () {
          const layer = yield* t.model.captureRequirements  // Model.d.ts:39
          const svc = yield* Layer.build(layer).pipe(
            Effect.map((ctx) => Context.get(ctx, LanguageModel.LanguageModel)))
          return { upTo: t.upTo, svc }
        }))
      const pick = (prompt: Prompt.RawInput) =>
        tokenizer.tokenize(prompt).pipe(                    // Tokenizer.d.ts:76–84
          Effect.map((tokens) =>
            services.find((s) => tokens.length <= s.upTo)?.svc
              ?? services[services.length - 1].svc))
      const service: LanguageModel.Service = {              // LanguageModel.d.ts:49
        generateText: (opts) => pick(opts.prompt).pipe(Effect.flatMap((m) => m.generateText(opts))),
        generateObject: (opts) => pick(opts.prompt).pipe(Effect.flatMap((m) => m.generateObject(opts))),
        streamText: (opts) => Stream.unwrap(pick(opts.prompt).pipe(Effect.map((m) => m.streamText(opts)))),
      }
      return service
    }),
  )

/** Fallback: try providers in order on retryable AiError tags. */
export const fallbackModel = (models: NonEmptyReadonlyArray<Model.Model<string, LanguageModel.LanguageModel, never>>) =>
  Layer.effect(LanguageModel.LanguageModel, Effect.gen(function* () {
    const services = /* build as above */
    const withFallback = <A>(f: (m: LanguageModel.Service) => Effect.Effect<A, AiError.AiError>) =>
      services.slice(1).reduce(
        (acc, next) => acc.pipe(Effect.catchTag(
          ["NetworkError", "RateLimitError", "QuotaExhaustedError", "InternalProviderError"],
          // AiError classes: AiError.d.ts:64, 305, 361, 597 — retry-worthy subset;
          // InvalidRequestError / ContentPolicyError / AuthenticationError do NOT fall through
          () => f(next.svc))),
        f(services[0].svc))
    // generateText/generateObject wrap directly; streamText needs re-request-from-start
    // semantics (a mid-stream provider failure cannot resume on another provider) —
    // acceptable because Stage-B journals per command, not per delta.
    ...
  }))
```

(Type plumbing elided — `pick` needs the overloads threaded; the point is that this is a
small, ordinary Layer, not a framework feature.)

Notes:

- Both combinators sit *under* the LanguageModel tag, so everything upstream — kernel,
  Check, Fold — is oblivious. This is Mastra's `ModelRouterLanguageModel` without the
  three-AI-SDK-spec adapter tax: effect/ai is one spec, ours.
- One caveat the wrapper introduces: `ProviderName`/`ModelName` become call-dependent,
  but the tags are Layer-scoped constants. The OM provider-change trigger (§2) must
  therefore read the *served* model, which the wrapper should expose by re-providing
  `ProviderName`/`ModelName` around each delegated call (both are plain string service
  tags — Model.d.ts:41–70 — so `Effect.provideService` per call suffices) and by
  recording the served pair on the `ModelCompleted` Trace event (§2.4 already requires
  the resolved model on `CallModel`; the fold reads it from the Trace, not from context).
- **Cheap-model folds**: OM's Observer/Reflector default to `gemini-2.5-flash` while the
  actor runs a frontier model (constants.ts:6, 25). Ours is per-agent model physics with
  zero new machinery: `AI.layer(Scribe).pipe(Layer.provide(Model.make("google",
  "gemini-2.5-flash", googleLayer)))` next to
  `AI.layer(Engineer).pipe(Layer.provide(Model.make("anthropic", "claude-…", …)))` —
  the same shape as the two-Bash demonstration, and worth the explicit §4.2 example the
  mastra report requested (insight 17).

---

## 6. Loop-as-workflow validation — their pipeline vs our §2.5 order

### Their pipeline, ours, and the diff

Mastra (agentic-loop/index.ts:92 `.dowhile`, agentic-execution/index.ts:113–140):

```
llmExecution → map(tool-calls, recompute HITL concurrency) → foreach(toolCallStep){concurrency}
  → llmMapping (fold results back; unknown-tool loopback) → backgroundTaskCheck
  → signalDrain → isTaskComplete → goal      [dowhile predicate: isContinued ?? false]
```

Ours (§2.5): `admit → body (turns) → drain steers → check → fold → halt decision →
repeat`.

Step-by-step accounting:

| Mastra step | ours | status |
|---|---|---|
| llmExecution + foreach(toolCall) + llmMapping | the §2.4 step machine *is* these three (CallModel/CallTool commands, pairing repair, budget per command) — Stage B, inside "body" | covered; strictly stronger (their per-step budget check is at boundaries only — pi #4325 is our counterexample) |
| HITL concurrency recomputation per step | §3 obligation above | **adopt** — was implicit, now stated |
| backgroundTaskCheck (inject finished background results before judging) | fork/background completion re-enters "as an ordinary trigger" (§9.3) | covered for *idle* rings; **gap for active runs** — see amendment A |
| signalDrain (+ re-drain in the dowhile predicate) | drain steers at boundary | covered — including their predicate re-drain: our admission inbox is re-read at every boundary, so a steer landing after the halt-favoring verdict still gets one more iteration only if the halt decision says continue; a steer against a *halted* run is new work, which is the correct semantics |
| isTaskComplete + goal (two judges) | one Check | covered; deliberately not duplicated |
| dowhile predicate defaulting `undefined → false` (agentic-loop/index.ts:291–295) | halt decision is a total function | covered by construction |
| snapshot only pending/paused/suspended + prune + terminal delete | adopted verbatim (§9.3) | covered |

And the substrate check: Stage-C on CF Workflows has the primitives it needs in
`effect/unstable/workflow` if we go that route — `Workflow.make` (Workflow.d.ts:168),
iteration bodies as `Activity.make` with `retry`/`idempotencyKey`
(Activity.d.ts:76, 91, 124), `Workflow.suspend` (Workflow.d.ts:393) and
`SuspendOnFailure` (Workflow.d.ts:415) for parking, and `DurableDeferred` for Ask
(DurableDeferred.d.ts:57–342 — `token`/`succeed`/`fail` is precisely
park-until-correlated-answer). The §3.2 note "evaluate backing `@effect/workflow`'s
engine with CF Workflows" stands; nothing found here contradicts it.

### Proposed amendments to §2.5

**A. Name the background-result injection point.** Mastra injects finished background
task results at the boundary *before* judging, and both judges skip when
`backgroundTaskPending` (is-task-complete-step.ts:44–46, goal-step.ts:116) because the
model hasn't seen the results yet. Our §2.5 routes fork completion through triggers,
which serves idle rings but leaves "a background task of an *active* run finished"
unplaced. Amendment: **fork/background completions targeting an active run are steers**
(they drain at the boundary like any mid-run input), and —

**B. The check grades only quiescent boundaries.** If the boundary drained steers or
injected background results, skip check *and* halt decision for that boundary (fold
still runs — it is the durability checkpoint and must never be skipped), set the
continue path, and let the body process the new input first. This is the single rule
that reproduces Mastra's three scattered gates (`backgroundTaskPending`,
`stepResult.isContinued`, drain-forces-continue) as one designed clause.

**C. Housekeeping iterations are non-gradeable.** Mastra skips judging when an
iteration's only tool calls were working-memory bookkeeping (goal-step.ts:119–122,
is-task-complete-step.ts:56–65). Our OM does its work out-of-band so the working-memory
case dissolves, but the same class exists for us: iterations whose only tool calls are
kernel-injected synthetics (`resolve` schema-bounce repairs, `recall` drillbacks, a
nag-response). Amendment: the kernel classifies an iteration as *housekeeping* when
every tool call in it is kernel-synthetic, and housekeeping iterations don't burn a
check invocation or a check budget run (they still fold).

**D. The check-budget defensive guard is subsumed but should be tested.** Mastra guards
re-entry of an at-budget objective without burning a judge call (goal-step.ts:146–169).
Ours: budgets are pre-call and transactional, so add the conformance case: "a boundary
reached with zero remaining check budget parks without invoking the check model."

Nothing else in their pipeline is missing from ours. Notably, three of their steps exist
only to work around architecture we don't have: `llmMapping`'s in-place
`stepResult.isContinued` writes (single-halt-point, §7), the RunScope reads sprinkled
through every step (serializable StepState, §7), and the concurrency-fallback comment on
resume paths (agentic-execution/index.ts:27–29 — their suspended `foreach` can resume
before the step recomputes tools; our active-toolset is part of linked Stage-A product,
re-derived on recovery from the term, not from a snapshot).

---

## 7. What to avoid — how the effect/ai design structurally prevents it

**Non-serializable-state registries (RunScope / `_internal` / globalRunRegistry TTLCache).**
Mastra's entire run-scope apparatus exists because tool `execute` closures, live
MessageLists, and controllers leak into step state that must survive suspension
(mastra.md weakness 2; run-scope reads visible in every step above, e.g.
tool-call-step.ts:88–99). The effect/ai design prevents this in the type system twice
over. First, live capability comes only from the environment: a `Toolkit.WithHandler` is
produced by `Toolkit.toLayer`/`toHandlers` (Toolkit.d.ts:55–64) at Layer construction —
Stage A — and reached through context; `StepState` holds tool *names and callIds*, never
handlers, and recovery re-links Stage A from the immutable term rather than rehydrating
a registry. Second, the transcript itself is schema'd data end-to-end: `Prompt` is a
`Schema.Codec<Prompt, PromptEncoded>` (Prompt.d.ts:1303) and even the convenience
`Chat` keeps history in a `Ref<Prompt>` with `export`/`exportJson`/`fromExport`
(Chat.d.ts:89, 115, 143, 412) — there is no object in the entire surface that *can't*
round-trip. The §2.4 conformance test (`StepState` survives `structuredClone` + process
restart) is enforceable because nothing in the library hands us a non-serializable thing
to be tempted by.

**Five stacked continuation mechanisms.** Mastra's `stepResult.isContinued` is written
by the mapping step, the drain step, the scorer step, the goal step, and the dowhile
callback (stopWhen + onIterationComplete + delegation bail), in that order, with
precedence emergent from `.then()` chaining (agentic-loop/index.ts:92–296;
mastra.md weakness 1). effect/ai prevents the *temptation* structurally: the library
exposes no loop, therefore no `stopWhen`, no `onStepFinish`, no per-iteration hook
surface for policies to colonize — `generateText` returns and the caller decides
(LanguageModel.d.ts:53–65). Continuation policy therefore has exactly one home: the
§2.5 halt decision, a total function of `(verdict, budget state, drained inputs,
interrupts)` with designed precedence (§1's table), producing the one `Halt` command.
The kernel surface must stay hook-free — `onIterationComplete` (which can inject fake
assistant messages *and* flip the decision, agentic-loop/index.ts:181–262) is the
cautionary tale: any caller-supplied boundary callback eventually gets write access to
the halt, and then precedence is emergent again.

**Stringly processor pipeline.** Mastra's universal extension point is one interface
with nine optional hooks whose persistence semantics live in prose
(`processInputStep` vs `processLLMRequest` vs `computeStateSignal`…), dispatched by
string id, with feature interactions discovered at runtime (OM×networks throws;
OM requires a feature flag; mastra.md weaknesses 4–5). The effect/ai-based design has no
hook vocabulary to accrete: extension is *substituting an implementation of a typed
tag* — `ContextPolicy`, `Durability`, `ToolInterceptor`, `Router` are `Context.Tag`s
private to the harness (§3.2), each with a complete typed contract, resolved at Layer
composition where a missing or incompatible provider is a compile error, not a
`MastraError`. The persistence-semantics-in-prose problem is likewise carried by types:
durable vs live is a type-level split on `KernelEvent` (`durable: false` deltas cannot
carry `seq`, Kernel.ts:36–39), and the response vocabulary is closed schemas
(`Response.StreamPart`, Response.d.ts:109–123) rather than an open `data-*` chunk
namespace. Where Mastra grew `processLLMRequest` (transient prompt rewrite) we have the
fold pipeline's fixed order `fold → render → markCacheBoundaries → CallModel` (§3.2);
where they grew `processAPIError` we have `Effect.retry`/`catchTag` over typed
`AiError`s in the model Layer (§5). Each need lands in an existing typed seam instead of
a tenth hook.

---

## Gap list

Gaps in effect/ai (kernel must supply):

1. **No agentic loop / multi-round tool driving** — by design; the §2.4 step machine is
   the driver. Use `disableToolCallResolution: true` (LanguageModel.d.ts:164–172) once
   Stage B owns CallTool interpretation; until then, single-round auto-resolution +
   kernel-driven rounds works (§1 sketch).
2. **No model fallback / tiering combinator** (Model.d.ts is metadata + one layer) —
   hand-rolled Layers per §5. Must also re-provide `ProviderName`/`ModelName` per
   delegated call and stamp the served model on Trace events, or OM's provider-change
   trigger reads stale data.
3. **`Tokenizer` is interface-only** (Tokenizer.d.ts:76–97, `make` at :133 takes *your*
   tokenize function) — per-provider token counting remains unscoped harness work
   (already §9.4); OM thresholds, tiering, and `usd` budgets all sit on it.
4. **No ask signing** — `ToolApprovalResponsePart` carries no authenticity; §9.3's
   "asks signed, answers verified" (AI SDK does HMAC) is kernel-side.
5. **No suspend/resume schema pair on tools** — tool-initiated suspension is our `Ask`
   payload-kind vocabulary, not a Tool field. Fine, but the payload/answer schemas need
   a home in the Ask event schema from v1.
6. **`generateObject` + toolkit in one call**: `GenerateObjectOptions` extends
   `GenerateTextOptions<Tools>` (LanguageModel.d.ts:183) so it type-checks, but
   `responseFormat: json` + tools is provider-dependent; the §1 sketch avoids relying on
   it (verify-with-tools rounds, then a `toolChoice: "none"` verdict call). Verify per
   provider before simplifying.
7. **Usage fields are all `UndefinedOr`** (Response.d.ts:1655–1707) — the §2.4 "declared
   policy for unknown usage" is load-bearing; nothing in the library defaults them.
8. **`Chat` is not the Trace** — a `Ref<Prompt>` convenience with its own persistence
   (Chat.d.ts:483–539). Usable as a Stage-B *candidate transcript carrier* (§2.2 says
   this) but its persistence layer would be a second representation; the Trace stays
   canonical, Chat (if used at all) stays in-memory per turn.
9. **Streaming fallback semantics** — a mid-stream provider failure can only restart the
   request on the next provider; acceptable under per-command journaling, but the
   fallback Layer must surface "restarted on fallback" as an event or budgets
   double-count the aborted stream's partial usage.

Gaps in our design surfaced by the comparison (proposed fixes inline above):

10. **§2.5 lacks a background-result injection point for active runs** → amendment A
    (completions targeting an active run are steers).
11. **Check gating at non-quiescent boundaries is unstated** → amendment B (grade only
    quiescent boundaries; fold always runs).
12. **Housekeeping-iteration classification is unstated** → amendment C.
13. **Per-trigger delivery policy (ifActive/ifIdle) is missing** → Router-seam attribute
    (§4), not a term.
14. **Sequential-degradation under Ask-capable toolkits** → §3's kernel obligation for
    §2.4's list.
15. **Fold/render cache key must include provider+model** — already flagged by the
    mastra report (insight 6); the §5 wrapper makes it urgent because routing makes the
    served model genuinely dynamic.

## Implementation order (Check/Fold arrows + Ask atop the Phase-2 kernel)

Ordered so every step lands on the previous one's tests, and the pure parts precede the
harness parts:

1. **Verdict types + halt-decision function (pure).** `CheckVerdict` schema +
   `BoundaryVerdict` (§1) in `src/AI/`; the boundary decision as a total pure function
   `(verdict, budgets, drained, interrupt) → Continue(feedback) | Halt(out) | Park(reason)
   | Escalate(question)` with property tests for the precedence table and amendments B–D.
   No I/O, no model — this is step-machine vocabulary.
2. **Default judge policy (no Check ref).** The kernel's own halt-condition audit via
   `LanguageModel.generateObject` — the load-bearing prompt asset, versioned with
   `promptHash` regression tests (§2.5). This exercises generateObject + verdict schema
   before Check-agent plumbing exists.
3. **Check arrow interpretation.** Stage-A link of the Check ref (judge agent's own
   model Layer + toolkit resolution from ambient context), the bounded verify-then-grade
   driver (§1 sketch), `CheckFailed` reification from `AiError`, feedback injection into
   the next iteration's seed, park semantics into the loop runtime. Conformance: a
   throwing judge parks with reason and never re-loops (Mastra's lesson as a test).
4. **Synchronous Fold arrow.** `fold: (carried, Trace) → carried'` as a boundary
   `generateText` under the fold agent's Layer; fold state in the checkpoint; the
   transactional commit rule (fold + events + budget decrement in one write). This is
   the durability floor and the OM substrate.
5. **Ask (approval kind first).** `Ask`/`AskAnswer` in the step machine mapped over
   effect/ai's approval parts (§3); callId-keyed ledger rows; pairing-invariant
   extension (interrupt during pending ask → synthetic denied/interrupted result);
   sequential-degradation obligation; the parallel-identical-calls property test. Memory
   kernel: park = a pending row + suspended fiber; Cloudflare tier later maps the same
   events to `waitForEvent`/`DurableDeferred` without touching the machine.
6. **Buffered Fold upgrade (OM Layer).** `OmFoldState` fields + pure trigger/activation
   functions (ports of buffering-coordinator.ts:108–144 and thresholds.ts:115–186 with
   tests against Mastra's semantics); background Observer fibers whose results enter as
   `om.*` Custom events; activation as boundary op with `threshold | ttl |
   provider_change`; cache-stable chunk rendering in the fold pipeline. Requires 4 + the
   §5 cheap-model Layer (trivial) + a Tokenizer stub (word-count first, per-provider
   later).
7. **`recall` tool + tiered/fallback model Layers.** Both are ordinary Layers over
   existing seams (trace read; LanguageModel wrap) — schedulable independently once 6
   and 2 exist, respectively.

Steps 1–5 are Phase-2 (memory kernel + conformance suite); 6–7 straddle into Phase-3
where the DO alarm (idle TTL), Queues (background spawns), and provider tokenizers live.
