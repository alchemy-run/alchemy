# Mapping OpenCode v2's session engine onto effect/ai (effect v4 `unstable/ai`)

**Question:** how would OpenCode v2's event-sourced session engine — durable admission
inbox, Coordinator, Context Epochs, scoped tool registry, permission Deferred-asks,
compaction checkpoints — be implemented on effect v4's unstable AI modules inside the
Alchemy AI kernel? OpenCode v2 is itself Effect-native (effect v4 betas: `Effect.fn`,
`Schema.TaggedErrorClass`, `FiberSet`, `Deferred`), so this is the closest-to-home
prior art we have.

**Method / verification.** Everything below is checked against real code:

- `effect@4.0.0-beta.93` as installed in this workspace
  (`node_modules/effect/dist/unstable/ai/*.d.ts` and, where the `.d.ts` was not
  enough, the shipped `.js`).
- `@effect/ai-anthropic@4.0.0-beta.93` and `@effect/ai-openai@4.0.0-beta.93`
  (the effect-v4 line, peer-pinned to `effect ^4.0.0-beta.93`). **These are not
  installed in this workspace** — they were fetched from npm and read from
  `/tmp/effect-ai-providers/*/package/src/*.ts`. Citations to provider sources use
  those paths. (The npm `latest` tags of these packages are the effect-v3 line —
  `@effect/ai-anthropic@0.26.0` peers on `effect ^3.21.3` and a separate
  `@effect/ai` package; the `beta` dist-tag is the v4 line that matches our
  `effect/unstable/ai`. Alchemy must pin the beta line.)
- OpenCode v2 vendored at `.vendor/opencode` (all files named below were read in full).

No API named below is invented; each is cited `file:line`.

---

## 0. The correspondence at a glance

| OpenCode v2 | Alchemy kernel (design §2.2–2.5, §3.1) | effect/ai primitive |
|---|---|---|
| `llm.stream(request)` — one Provider Turn | one `CallModel` command | `LanguageModel.streamText` (`LanguageModel.d.ts:73-85`) with `disableToolCallResolution: true` (`:164-172`) |
| Session Drain (3 nested whiles, `llm.ts:383-406`) | Stage-C loop runtime driving the §2.4 step machine | our interpreter loop (effect/ai has no loop — good) |
| `SessionInput` admit/promote (`input.ts`) | admission ledger, plane 1 of the Ring DO | none — ours (DO SQLite) |
| `SessionRunCoordinator` (`run-coordinator.ts`, 104 lines) | per-ring serialization inside the Ring DO | `Deferred` + `FiberSet` in-process; DO single-threading + alarm durably |
| `EventV2` durable log + projectors (`event.ts`) | the Trace, plane 2 | none — ours. `Chat.Persistence` is NOT this (see §8.6) |
| eager tool settlement (`llm.ts:249-271`) | `CallTool` journaled → interpreter settles | `Toolkit.WithHandler.handle` (`Toolkit.d.ts:147-155`), called by us |
| Context Epoch + Context Sources (`context-epoch.ts`, `system-context/index.ts`) | renderer + `ContextPolicy` seam | `Prompt` system messages anywhere in `content` (`Prompt.d.ts:1248,1283`), per-part provider `options` (`Prompt.d.ts:763-773`) |
| `PermissionV2.assert` Deferred-ask (`permission.ts:197-218`) | durable `Ask` row + alarm on the Ring DO | **not** effect/ai's `needsApproval` (see §5 — landmine) |
| scoped registry + stale-call rejection (`registry.ts:50-61`) | Stage-A toolkit capture + interpretation-time identity check | `Toolkit.make`/`Tool.dynamic` per turn (`Toolkit.d.ts:212`, `Tool.d.ts:905-971`) |
| compaction started/ended events (`compaction.ts:186-222`) | fold-variant emitting `KernelEvents` | one extra `streamText` call, no toolkit |

---

## 1. The drain loop on effect/ai

### 1.1 What OpenCode does, precisely

The whole engine is three nested `while`s (`.vendor/opencode/packages/core/src/session/runner/llm.ts:383-406`):

```ts
while (shouldRun) {                    // ← drain: while queued inputs exist
  let needsContinuation = true
  let step = 1
  while (needsContinuation) {          // ← provider turns
    const result = yield* runTurn(input.sessionID, promotion, step)
    needsContinuation = result.needsContinuation
    step = result.step + 1
    promotion = "steer"                // every subsequent turn promotes steers
    if (!needsContinuation)
      needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
  }
  shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
  promotion = shouldRun ? "queue" : undefined
}
```

Inside `runTurnAttempt` (`llm.ts:173-348`):

- **Steer promotion resets the step budget**: `if (promoted > 0) currentStep = 1`
  (`llm.ts:187-196`). Promotion happens at the top of the turn, before request
  assembly — the "safe provider-turn boundary".
- **Last-step behavior**: when `currentStep >= agent.info.steps`, the request gets
  `messages: [...history, Message.assistant(MAX_STEPS_PROMPT)]` and
  `toolChoice: "none"`, and **no tools are materialized at all**
  (`llm.ts:202-213`; `MAX_STEPS_PROMPT` is a "tools are disabled, summarize" text,
  `runner/max-steps.ts:1-16`). A tool call that arrives anyway (provider ignoring
  `toolChoice`) is failed with "Tools are disabled after the maximum agent steps"
  (`llm.ts:244-247`).
- `needsContinuation` is set **only** when a non-provider-executed `tool-call`
  event arrives (`llm.ts:243-248`); no tool calls ⇒ the inner loop ends.

### 1.2 The mapping

One `llm.stream(request)` ≙ one `LanguageModel.streamText(...)` call. Verified
surface:

- `toolChoice: "none"` is in the type: `ToolChoice<ToolName> = "auto" | "none" |
  "required" | { tool } | { mode?, oneOf }` (`LanguageModel.d.ts:212-217`; accepted
  at `GenerateTextOptions.toolChoice`, `:156-158`). ✅ verified.
- `disableToolCallResolution: true` returns the raw decoded `StreamPart` stream
  without executing anything (`LanguageModel.d.ts:164-172`; implementation
  short-circuits at `LanguageModel.js:674-685` for streaming, `:503-513` for
  generate). Tool-call resolution is ours.

OpenCode's three whiles become our Stage-B/Stage-C split. The inner two whiles are
the **turn driver** (Stage B, §2.4 step machine); the outer while is the **loop
runtime** (Stage C, §2.5) reading the admission ledger. Feedback-shaped, the same
control flow is:

```ts
// Stage B: one provider turn = interpret the CallModel command
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"

const runProviderTurn = Effect.fn(function* (cmd: CallModel, toolkit: Toolkit.WithHandler<any>) {
  const isLastStep = cmd.step >= cmd.maxSteps
  const parts = yield* LanguageModel.streamText({
    prompt: Prompt.make([
      ...cmd.messages,
      // OpenCode injects MAX_STEPS_PROMPT as a trailing *assistant* message
      ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
    ]),
    toolkit: isLastStep ? undefined : toolkit,      // OpenCode: no tools on last step
    toolChoice: isLastStep ? ("none" as const) : undefined,
    disableToolCallResolution: true,                 // settlement is the interpreter's
  }).pipe(
    Stream.runForEach((part) => interpretStreamPart(part)),  // → Trace events + CallTool commands
  )
  // ...
})
```

Correspondences, item by item:

| OpenCode | Ours |
|---|---|
| `runTurn` recursion via `TurnTransitionError` defects | a `phase` transition in `StepState` (§7 — we reject the defect pattern) |
| `promotion: "steer"` after every inner turn; `hasPending(steer)` re-check when the model stops calling tools | drain-steers check in the step machine's boundary transition: `Steered` feedback is delivered only between `CallModel` commands, and a delivered `Steered` **resets `budget.stepsUsed` to 0** (design §2.4 "promotion resets the step allowance"; OpenCode `llm.ts:195` `if (promoted > 0) currentStep = 1`) |
| `hasPending(queue)` at the drain boundary | the Ring DO reducer re-reading plane 1 (rows are truth) and admitting the next work item |
| `needsContinuation` set on `tool-call` stream events | `step` emits another `CallModel` iff the previous `ModelResponse` feedback contained ≥1 `CallTool` that settled; "no tool calls" is the *default* halt producer (§2.4 last rule) |
| last-step `toolChoice:"none"` + `MAX_STEPS_PROMPT` + tools **omitted** | identical; note OpenCode both omits the tools *and* sets `"none"` — belt and suspenders because providers ignore `toolChoice` sometimes; we should do both too (`toolkit: undefined` makes effect/ai take the no-toolkit path, `LanguageModel.js:552-580`) |

Two effect/ai details the step machine must absorb:

1. **Stream part vocabulary.** `Response.StreamPart` =
   `TextStart/Delta/End | ReasoningStart/Delta/End | ToolParamsStart/Delta/End |
   ToolCallParts | ToolResultParts | ToolApprovalRequestPart | File… |
   ResponseMetadataPart | FinishPart | ErrorPart` (`Response.d.ts:109`). Deltas map
   to our non-durable `ModelDelta` (`durable: false`, they never carry `seq`);
   `tool-call` parts arrive with **complete parsed params** — that is the eager-
   settlement trigger point (§3). `FinishPart` carries `FinishReason`
   (`"stop" | "length" | "content-filter" | "tool-calls" | …`, `Response.d.ts:1632-1655`)
   and `Usage` with `inputTokens.{uncached,total,cacheRead,cacheWrite}` and
   `outputTokens.{total,text,reasoning}` — **every count `UndefinedOr<Number>`**
   (`Response.d.ts:1656-1695`). That is exactly the §2.4 "AI SDK v4 usage shape,
   every count possibly absent" requirement; budget accounting decrements from the
   `FinishPart` feedback with the declared unknown-usage policy.
2. **`finishReason: "length"` on a tool-call batch** is the truncated-arguments
   case: the §2.4 pairing invariant says the whole batch fails wholesale. The
   interpreter checks `FinishPart.reason` before settling any `CallTool` from that
   turn.

`Chat` (`Chat.d.ts`) is **not** the transcript carrier for Stage B. Its state is a
`Ref<Prompt.Prompt>` (`Chat.d.ts:89`) mutated per call — a second, in-memory
transcript, which §3.1 forbids ("two planes, never a second transcript"). Our
prompt is *derived* (repair-on-read) from the Trace each turn, exactly like
OpenCode's `SessionHistory.entriesForRunner(db, id, baselineSeq)` (`llm.ts:200`).
`Chat.export/fromExport` remains useful only for the dev-mode in-memory kernel.

---

## 2. The Coordinator in Effect v4 primitives

OpenCode's `Coordinator` (`run-coordinator.ts:1-104`) is 104 lines over exactly
`Deferred` + `FiberSet` + `Fiber` + `Exit`:

- `run(key)` — join-or-start: if an entry exists, `Deferred.await(entry.done)`
  (joining a stopping entry chains `await → run(key)` again, `:71`); else create
  entry, fork the drain on a `FiberSet.makeRuntime`, await `done` (`:67-79`).
- `wake(key)` — coalesced: if active, set `pendingWake = true` (a **capacity-1
  dirty bit**, not a queue); else start a non-forced drain (`:81-92`).
- `settle` — on drain exit: if success && pendingWake, clear the bit and start a
  **successor** drain under the *same* entry (so joiners keep waiting, `:52-56`);
  on failure with pendingWake, a *new* entry + successor, and the old `done` is
  completed with the failure (`:58-64`).
- `interrupt(key)` — `stopping = true; pendingWake = false; Fiber.interrupt(owner)`
  (`:94-101`).

Amusingly, effect/ai itself uses the same idiom internally:
`Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))` appears both
in OpenCode (`llm.ts:141-142`) and in `LanguageModel.js:756`. The vocabulary
transplants directly.

### 2.1 The Ring DO version

The Ring DO replaces the mutex the Coordinator implicitly is: **a Durable Object is
single-threaded, so per-key serialization is free**; what remains of the Coordinator
is (a) the coalesced-wake dirty bit — made durable, (b) the join protocol —
process-local `Deferred`s are fine for `dispatch` joins because a caller that loses
its process re-derives the answer from the Trace, and (c) interrupt-as-stimulus —
which §3.1 already demands go through the one inbox ("a cancel is a stimulus like
any other").

```ts
// Inside the Ring DO (design §3.1 plane 1 + the reducer).
// DO single-threading = the Coordinator's Map<Key, Entry> for free; one ring = one key.
interface RingCoordination {
  drainOwner: Fiber.Fiber<void> | undefined       // in-memory; dies with the DO — fine
  pendingWake: boolean                             // in-memory mirror of the durable dirty bit
  joins: Map<WorkItemId, Deferred.Deferred<Out, Err>>  // process-local dispatch joins
}

// admit(): plane-1 write (idempotent by deliveryId), then wake — identical split
// to OpenCode's SessionInput.admit (durable row) + coordinator.wake (advisory).
const admit = Effect.fn(function* (delivery: Delivery) {
  const receipt = yield* ledger.admit(delivery)          // durable, idempotent (input.ts:41-81 shape)
  if (receipt.duplicate) return receipt
  yield* wake                                            // hint, not truth
  return receipt
})

const wake = Effect.gen(function* () {
  if (coordination.drainOwner) { coordination.pendingWake = true; return }
  yield* state.storage.put("dirty", true)                // durable dirty bit
  yield* state.storage.setAlarm(Date.now())              // edge-triggered wake
})

// alarm handler = Coordinator.start + settle, with rows as truth:
const alarm = Effect.gen(function* () {
  yield* state.storage.put("dirty", false)
  coordination.drainOwner = yield* drain.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        coordination.drainOwner = undefined
        // settle(): successor iff new work arrived while draining —
        // re-READ the ledger instead of trusting pendingWake (rows are truth;
        // OpenCode's hasPending re-check at llm.ts:401,403 is the same move)
        const more = coordination.pendingWake || (yield* ledger.hasRunnable)
        coordination.pendingWake = false
        if (more) yield* wake
        yield* settleJoins(exit)                          // complete process-local Deferreds
      })),
    Effect.forkScoped,                                    // FiberSet-equivalent supervision
  )
})

// interrupt: a control admission through the same inbox — no second control plane.
// The reducer sees kind:"control" at the next boundary, interrupts drainOwner,
// settles in-flight CallTools as typed interruptions (pairing invariant), folds, marks.
```

Deltas from OpenCode, deliberate:

- **Their `pendingWake` is in-memory only** — a crash loses the wake, and they
  accept it because a future `run` re-reads the inbox. On a DO we get the stronger
  version for free: the dirty bit + alarm are durable, and the reducer re-reads
  plane 1 regardless (design §3.1 "wakes are hints, rows are truth"; OpenCode's
  durable-tail uses the same edge-triggered sliding-1 signal per aggregate,
  `event.ts:565-604`).
- **Their `run` joins a live fiber**; our `dispatch` join is a process-local
  `Deferred` in the *calling* Worker plus a durable fallback: the run's result is
  a Trace event, so a re-connected caller replays `trace(ring, after)` to find it.
  This is why "no reified run object" (their CONTEXT.md doctrine, our §9.5) is
  load-bearing: the join handle is reconstructible.
- **`stopping` + successor-entry dance** collapses: since interrupt is an inbox
  row, ordering interrupt-vs-work is the ledger's FIFO, not entry bookkeeping.

### 2.2 Step-budget reset on steer promotion (where it lives)

In OpenCode, promotion is a *turn-scoped* act (`runTurnAttempt` promotes, then
`currentStep = 1`). In our machine, promotion is interpreter-side (the ledger
marks steer rows promoted at the boundary) and the reset is pure: the `Steered`
feedback carries the promoted items, and `step(state, Steered)` returns a state
with the step allowance reset and the items appended as the next user input. The
conformance property: *delivering `Steered` never occurs between a `CallTool`
command and its `ToolResult` feedback* (mid-turn steering is forbidden; §2.4).

---

## 3. Eager tool settlement as our command interpreter

### 3.1 What OpenCode does

Per `tool-call` stream event (`llm.ts:243-271`):

1. `needsContinuation = true`.
2. Durably record the call **before side effects** — the tool-call event is
   published under the one-permit publication semaphore (`withPublication`,
   `llm.ts:228-230`) before `settle` runs; the checklist item is explicit:
   *"Durably record each tool call before side effects begin"* (`llm.ts:70`).
3. Fork settlement immediately on a `FiberSet` (`FiberSet.run(toolFibers)`,
   `llm.ts:271`), wrapped `uninterruptibleMask` so a settlement that started
   always publishes its result (`llm.ts:250-270`).
4. After the provider stream closes: `awaitToolFibers = raceFirst(join, awaitEmpty)`
   (`llm.ts:141-142,296`), then classify: user-declined ⇒ clear fibers, fail the
   rest as "Tool execution interrupted", `Effect.interrupt` (`llm.ts:297-301`);
   interrupted ⇒ same fills (`llm.ts:302-310`); plain failure ⇒ "Tool execution
   failed: …" fills (`llm.ts:311-315`).
5. Reload projected history **once** before the next turn (`entriesForRunner`
   re-read at the top of the next `runTurnAttempt`).
6. **Crash rule**: at drain start, any tool still projected `pending`/`running`
   from a dead process is durably failed as `"Tool execution interrupted"` before
   any request is assembled — never re-executed (`failInterruptedTools`,
   `llm.ts:119-139`, called at `llm.ts:390`).

### 3.2 What control effect/ai actually gives (verified)

- **`disableToolCallResolution: true` fully disables framework execution.** In
  streaming it returns the decoded raw stream before any `handleToolCall` forking
  (`LanguageModel.js:674-685`); in generate it returns content without
  `resolveToolCalls` (`:503-513`). The type-level error channel drops
  `Tool.HandlerError` accordingly (`ExtractError`, `LanguageModel.d.ts:355-362`).
- **If resolution is left enabled**, effect/ai already implements OpenCode's inner
  pattern itself: per `tool-call` part it forks `handleToolCall` on a `FiberSet`
  (`LanguageModel.js:747-751`), defers `finish` parts until all handlers settle
  (`:733-742,756`), and emits `tool-result` parts into the output queue. What it
  does **not** do: durably record the call before executing, synthesize
  interruption fills, or respect a publication order we can journal. Settlement
  order and durability are invisible to us.
- **`Toolkit.WithHandler.handle(name, params)`** is public and exactly the right
  granule for our interpreter: `Effect<Stream<Tool.HandlerResult, HandlerError,
  HandlerServices>, AiError>` (`Toolkit.d.ts:147-155`) — a stream because handlers
  may emit preliminary results (`HandlerContext.preliminary`, `Toolkit.d.ts:72-82`).

**Decision: yes — disable effect/ai's resolution and settle through our
interpreter.** The pairing invariant (§2.4) requires that blocked, interrupted, and
truncated calls synthesize results *durably*; effect/ai's resolver can't be taught
that without owning the journal. We keep the toolkit for (a) tool definitions sent
to the provider and (b) `handle` as the execution entry.

```ts
// Stage-B interpreter around one streamText turn (all APIs verified above)
const toolFibers = yield* FiberSet.make<void, never>()

yield* LanguageModel.streamText({
  prompt, toolkit, disableToolCallResolution: true,
}).pipe(Stream.runForEach((part) =>
  Effect.gen(function* () {
    switch (part.type) {
      case "text-delta":
      case "reasoning-delta":
      case "tool-params-delta":
        return yield* emitLive(part)                    // durable:false, never advances seq
      case "tool-call": {
        // 1. Durable record BEFORE side effects — ToolRequested commits to the Trace
        //    with deterministic id (term, session, turn, part.id). Emission ordering
        //    is normative: ToolRequested precedes any gate (§2.3).
        yield* trace.append(ToolRequested({ callId: part.id, name: part.name, input: part.params }))
        // 2. Fork settlement eagerly; publication of the result is uninterruptible.
        yield* Effect.uninterruptibleMask((restore) =>
          restore(settle(toolkit, part)).pipe(           // decode→intercept→handle→bound
            Effect.flatMap((r) => trace.append(ToolCompleted({ callId: part.id, ...r }))),
          ),
        ).pipe(FiberSet.run(toolFibers))
        return
      }
      case "finish":
        return yield* recordUsage(part)                  // budget decrement, same txn as Trace write
      default:
        return yield* emitDurable(part)
    }
  })))

// 3. After stream close: await all settlements — the exact OpenCode/effect/ai idiom
yield* Effect.raceFirst(FiberSet.join(toolFibers), FiberSet.awaitEmpty(toolFibers))
// 4. Classify exits; synthesize "interrupted" fills for unsettled callIds
//    (repair-on-read makes this idempotent — fills are deterministic).
// 5. Reload prompt from Trace once (repair-on-read pass), next CallModel.
```

Where `settle` is our pipeline mirroring OpenCode's registry settle
(`registry.ts:62-82`): decode input (invalid input never invokes the handler —
`Tool.dynamic` with an Effect Schema gives validation for free, `Tool.d.ts:872`),
run the `ToolInterceptor` seam (block ⇒ synthesized result per the pairing
invariant), `toolkit.handle(name, params)`, encode output (invalid output never
settles as success — effect/ai raises `AiError.ToolResultEncodingError`,
`AiError.d.ts:1026`), then output bounding (preview + Managed-Output-File
retention; retention failure fails settlement operationally, never "lossy
success" — their `ToolOutputStore.bound` rule).

**The crash rule maps verbatim** and is already normative in §2.4/§9.3: on Ring DO
recovery, before assembling any request, every `ToolRequested` in the Trace without
a matching terminal event is closed with a synthetic
`ToolFailed({ error: "interrupted" })` — deterministic id, so replay collides
idempotently. Never re-execute. This is `failInterruptedTools` (`llm.ts:119-139`)
as a *pure repair-on-read pass* instead of a mutate-the-projection step — our
improvement, since the fill composes with any fold/trim.

Interruption semantics to copy exactly: OpenCode `FiberSet.clear`s (interrupting)
in-flight settlements on stream interrupt/user-decline, then fails the unsettled
(`llm.ts:295-310`). `FiberSet.clear` exists in effect v4 (used at
`run-coordinator.ts` scale; verified import surface `effect` root). The
uninterruptible *publication* window is what guarantees a settlement that reached
its side effect always reaches the Trace.

---

## 4. Context Epochs / Context Sources over effect/ai `Prompt`

### 4.1 What OpenCode does

- A **Context Source** is `{ key, codec, load, baseline(current), update(prev,
  current), removed?(prev) }` (`system-context/index.ts:32-39`), composed by key
  with duplicate rejection (`:176-180`), observed concurrently (`:182-195`).
  `unavailable` is stale-while-revalidate: refresh keeps the admitted snapshot;
  *initial* unavailability **blocks the first turn** (`InitializationBlocked`,
  `:198-206`) rather than persisting an incomplete baseline.
- A **Context Epoch** row per session holds `{ baseline, snapshot, baseline_seq }`
  (`context-epoch.ts:122-139`). The baseline string is **immutable** — the
  provider-cache anchor. Changed sources are rendered by `update(prev, current)`
  and admitted as a **chronological system message** (`SessionEvent.ContextUpdated`)
  whose projector writes the message while the epoch snapshot advances **in the
  same commit** (`events.publish(..., { commit: () => advance(...) })`,
  `context-epoch.ts:72-76`).
- After a compaction (a new history boundary), `replace` builds a whole new
  baseline — blocked while any previously-admitted source is unavailable
  (`ReplacementBlocked`, `system-context/index.ts:287-291`; epoch replace at
  `context-epoch.ts:59-69`).
- Request assembly: `system: [agent.system, epoch.baseline]` as system parts, and
  history read **from `baselineSeq`** (`llm.ts:197-211`);
  `providerOptions: { openai: { promptCacheKey: sessionId } }` (`llm.ts:204-207`).

### 4.2 The effect/ai mapping

Verified `Prompt` facts that make this fit naturally:

- `Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage`
  (`Prompt.d.ts:1248`) and `Prompt.content: ReadonlyArray<Message>`
  (`Prompt.d.ts:1278-1284`) — **system messages may appear anywhere in the
  array**, so "chronological mid-conversation system message" is directly
  representable. (`setSystem`/`prependSystem`/`appendSystem` exist for the head
  block, `Prompt.d.ts:1550,1648,1742`, but we build content positionally anyway.)
- Every message and part carries provider-namespaced `options`
  (`Prompt.d.ts:763-773`; schema `:16`), extended by module augmentation per
  provider.

How cache options actually flow (verified in the beta-93 providers):

- **Anthropic**: `Prompt` augmentation adds `options.anthropic.cacheControl`
  (ephemeral cache breakpoints) on system messages, user messages/parts, tool
  messages (`/tmp/.../ai-anthropic/package/src/AnthropicLanguageModel.ts:126-208`
  module augmentation). System blocks: `cache_control: getCacheControl(message)`
  (`:913`); user parts: part-level, falling back to message-level on the last part
  (`:932-941`); `getCacheControl` reads `part.options.anthropic?.cacheControl`
  (`:2900-2909`). **Gap**: assistant-content cache breakpoints are `TODO` — read
  but discarded (`:1061-1066` `// TODO: use cache_control in content blocks`). For
  the classic "breakpoint after the last assistant message" pattern this means the
  anchor must sit on the preceding user/tool message instead. Livable, worth an
  upstream PR.
- **OpenAI**: `OpenAiLanguageModel.Config` is
  `Partial<Omit<CreateResponse.Encoded, "input"|"tools"|"tool_choice"|"stream"|"text">>`
  (`OpenAiLanguageModel.ts:80-88`) spread directly into the request (`:619-629`
  `{ ...apiConfig, input: messages, ... }`), and `CreateResponse.Encoded` includes
  `prompt_cache_key` (`Generated.ts:24524,25759`). So OpenCode's
  `promptCacheKey: sessionId` is `OpenAiLanguageModel.withConfigOverride(effect,
  { prompt_cache_key: ringSessionKey })` — scoped per call, merged over layer
  defaults (`:702-720`, override precedence documented at `:585-591`). Anthropic
  has no cache key; breakpoints are the mechanism.

The kernel-side contract (a `ContextPolicy`-adjacent seam of the harness, per
design §3.2 — *not* a Kernel-interface concept):

```ts
// Cloudflare.AI.ContextSources — private tag of the harness layer
export interface ContextSource<A> {
  readonly key: string
  readonly codec: Schema.Codec<A, Schema.Json>
  readonly load: Effect.Effect<A | Unavailable>
  readonly baseline: (current: A) => string
  readonly update: (previous: A, current: A) => string
  readonly removed?: (previous: A) => string
}
```

Epoch mechanics on our two planes:

1. **Baseline** = `render(term)` (the immutable charter — already outside
   ContextPolicy's jurisdiction, §3.2) `+` the epoch's source baseline. Stored on
   plane 2 as an `EpochInitialized` durable event carrying
   `{ baseline, snapshot, baselineSeq, promptHash }`. The rendered prompt's system
   block per turn is `[charter, epoch.baseline]` — two `SystemMessage`s at the
   head, with `options.anthropic.cacheControl: { type: "ephemeral" }` on the
   second as the cache breakpoint.
2. **Reconcile before each `CallModel`** (Stage-B request assembly): observe
   sources; unchanged ⇒ nothing; changed ⇒ emit a durable `ContextUpdated` Trace
   event whose payload is the `update(prev, current)` text, **committed atomically
   with the snapshot advance** — on plane 2 this is one DO-SQLite transaction, the
   exact `{ commit }` hook OpenCode threads through `EventV2.publish`
   (`event.ts` transactional projection; `context-epoch.ts:72-76`). Repair-on-read
   renders `ContextUpdated` events as chronological `SystemMessage`s at their
   `seq` position.
3. **Fold boundary = epoch replacement opportunity**: after `IterationFolded`
   (our compaction analogue), `replace` builds a fresh baseline; blocked while an
   admitted source is unavailable, exactly their `ReplacementBlocked`. The fold
   pipeline order stays normative: `fold → render → markCacheBoundaries →
   CallModel` (§3.2).
4. **Initial unavailability blocks the first turn** — surfaced as a typed
   `KernelError` at interpretation, not a silent partial baseline.

What this buys over OpenCode: because `ContextUpdated` is an ordinary Trace event,
context changes are **visible to folds and autoresearch** (design insight 7) — in
OpenCode they're visible only as projected messages.

---

## 5. Permission asks: their Deferred, our durable row

### 5.1 What OpenCode does (and its own caveat)

`PermissionV2` (`permission.ts`): rules `{ action, resource, effect: allow|deny|ask }`
evaluated wildcard-`findLast` with default `ask` (`:76-86`). `assert`:

- deny ⇒ typed `BlockedError` (model-visible failure) (`:201-205`);
- allow ⇒ pass (`:206`);
- ask ⇒ create a **pending row in an in-memory `Map`**, publish `Event.Asked`,
  `Deferred.await` under `uninterruptibleMask` (`:197-218`).

`reply` (`:220-286`): `"reject"` with a message ⇒ `CorrectedError({ feedback })`;
bare reject ⇒ `DeclinedError` **and cascades a decline to every other pending ask
in the session** (`:237-246`); `"always"` ⇒ persist saved rules (project-scoped),
succeed the Deferred, then **retroactively approve** any other pending ask the new
rules now cover (`:259-283`). `DeclinedError` is thrown as a *defect* that halts
the drain (`llm.ts:144-150` scans the cause for it) — a decline is control flow,
not tool output. `CorrectedError` flows back typed (their layer finalizer also
fails all pending asks with `DeclinedError` on shutdown, `:119-129` — the restart
caveat: **pending asks do not survive the process**; the checklist item "Mark
busy, retrying, idle, interrupted…durably" is unchecked, `llm.ts:52`).

Permission checks live **inside trusted tools**, not the registry: built-ins
capture the service at construction and call `assert` themselves (their
`specs/v2/tools.md:94-133`; "sharing a tool type does not imply equal authority").

### 5.2 Why we cannot use effect/ai's approval machinery (verified landmine)

effect/ai has a native approval flow: `Tool.make(..., { needsApproval })`
(`Tool.d.ts:810-854`), a `tool-approval-request` **response** part emitted instead
of execution (`Response.d.ts:1139-1218`; emission at `LanguageModel.js:704-712`),
and a `tool-approval-response` **prompt** part the caller appends
(`Prompt.d.ts:599-662`). On the **next** call, pending approvals are pre-resolved:
approved calls are executed (`executeApprovedToolCalls`), denials become denial
results, both injected as a tool message, and resolved artifacts are stripped
before the provider sees the prompt (`LanguageModel.js:613-661`; stripping
rationale — OpenAI rejects `mcp_approval_response` items referencing unknown ids —
`:920-931`).

Two disqualifiers for our kernel:

1. **Pre-resolution runs even with `disableToolCallResolution: true`.** In
   `streamContent` the pending-approval block (`LanguageModel.js:613-651`) executes
   *before* the `disableToolCallResolution` early return (`:674`). If our prompt
   ever contains approval-response parts, effect/ai will execute the approved tool
   **itself**, outside our journal, breaking record-before-side-effects. So the
   kernel must never emit `needsApproval` tools or approval parts into prompts.
2. The approval Deferred lives in the model-call loop; ours must park on the Ring
   DO for days (their own restart caveat is the argument).

### 5.3 The durable Ask

`Ask` is the §2.4 one-durable-wait primitive; the gate lives in the **tool Layer**
(who decides) with `ToolInterceptor` as the policy substrate underneath (what
applies), mirroring their tools-own-their-gates stance. The handler a Toolkit
handler calls:

```ts
// Cloudflare.AI.Ask — a private harness service the human-gated tool Layers use.
// Pending ask = durable row + alarm, NOT an in-memory Deferred.
export class Ask extends Context.Tag("cf/ai/Ask")<Ask, {
  readonly ask: (input: {
    readonly kind: "approval" | "question" | "oauth" | "budget"
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>          // patterns an "always" may persist
    readonly payload: unknown
  }) => Effect.Effect<AskVerdict, Declined | Corrected>
}>() {}

export type AskVerdict = {
  readonly verdict: "allow"
  readonly amendment?: { readonly scope: "session" | "ring"; readonly rules: Ruleset }
}
export class Declined extends Data.TaggedError("AI.Ask.Declined")<{}> {}       // halts the run
export class Corrected extends Data.TaggedError("AI.Ask.Corrected")<{         // re-enters the loop
  readonly feedback: string
}> {}
```

Implementation over the two planes:

```ts
// inside a trusted tool's handler (e.g. Bash write-mode Layer):
const ask = yield* Ask
const settle = Effect.fn(function* (params: BashParams) {
  yield* evaluate(rules, "bash", params.command).pipe(          // findLast-wildcard, default "ask"
    Effect.flatMap((rule) =>
      rule.effect === "deny"  ? new Declined()                  // typed; distinct Trace event (§2.3)
      : rule.effect === "allow" ? Effect.void
      : ask.ask({ kind: "approval", action: "bash", resources: [params.command],
                  save: [globOf(params.command)], payload: params })),
  )
  return yield* runBash(params)
})
```

The harness's `Ask.ask`:

1. Emit durable `Escalated`/`AskIssued` (deterministic id `(term, session, turn,
   callId)`; the ask is **signed** — answers arrive over world surfaces, §9.3) and
   write a plane-1 pending-ask row `{ askId, callId, deadline }` + DO alarm for the
   timeout escalation — in one transaction.
2. Return control. **The turn does not block a fiber**: at the step-machine level
   the in-flight `CallTool` is parked (suspension keyed by `callId`, never name —
   §2.4) and the Ring DO goes idle. This is the structural difference from their
   `Deferred.await` — and it's the durable version of what they deferred.
3. The answer arrives as an ordinary admission (webhook → `admit`, idempotent by
   delivery id; unrelated input during a pending ask is held, never treated as a
   denial — §9.3). The reducer verifies the signature, then:
   - **allow** ⇒ resume the parked settlement; if `save` patterns were granted
     ("always"), persist the rule delta as **fold-visible ring state** and — their
     retroactive sweep (`permission.ts:259-283`) — re-evaluate every other pending
     ask row against the amended rules, resuming those now covered. All in the
     Trace: the autonomy dial ratchets with its history (§9.3).
   - **decline** ⇒ their split, kept exactly: bare decline is an escalation-halt
     (non-model-visible control signal; the drain stops; other pending asks of the
     run settle declined — their cascade `:237-246`), while decline-with-feedback
     is `Corrected` ⇒ the pairing invariant synthesizes a model-visible denial
     `ToolResult` carrying the feedback, and the loop continues (three outcomes,
     not two — design insight 10).
4. Alarm fires with no answer ⇒ typed timeout escalation `KernelEvent`; the
   default policy parks the run (`waiting` verdict, §2.5), not a decline.

Recovery: pending-ask rows are plane-1 state; a DO eviction changes nothing. The
`failInterruptedTools` sweep (§3) must **exclude** callIds with a live pending-ask
row — parked-on-ask is not orphaned. (OpenCode can't make this distinction; we can
because the park is a row, not a fiber.)

---

## 6. Scoped tool registry with stale-call rejection

### 6.1 What OpenCode does

`ToolRegistry` (`tool/registry.ts`): registrations are name → stack of
`{ token, registration: { identity: object, tool } }` — **overlay semantics**,
latest wins; closing the registering `Scope` removes exactly that overlay via
`Effect.addFinalizer` filtering by token (`:85-105`). `materialize(permissions)`
snapshots the *current* registration map for one provider turn (`:106-122`) and
returns `{ definitions, settle }` where `settle` closes over the snapshot; at
settlement, `registration.identity !== advertised` ⇒
`"Stale tool call: <name>"` **without executing** (`:50-61`). Identity is a fresh
`{}` per registration — reference equality, nothing clever. Unknown name ⇒
`"Unknown tool"`; wholly-disabled-by-permission tools are removed from the
materialization entirely (`:112-113,132-135`).

### 6.2 Our mapping — Stage-A assembly + interpretation-time capture

Our analogue of "registration" is Stage-A linking (§2.2): tool refs resolve their
impls from ambient context once per Layer construction, producing `Tool.dynamic`
definitions + Toolkit handlers. The hazard is stated in design insight 9: per-ring
Layer recomposition is our headline feature, so a redeploy/hot-swap mid-flight
must not let a call execute a different impl than the one whose schema the model
saw.

```ts
// Stage A (per term-Layer construction): capture identity alongside the toolkit.
interface LinkedTool {
  readonly identity: object                  // fresh {} per link — reference equality, like theirs
  readonly tool: Tool.Any                    // Tool.dynamic(name, { parameters, ... })  (Tool.d.ts:905-971)
  readonly handler: (params: unknown) => Effect.Effect<...>
}
const link = Effect.gen(function* () {
  const impls = yield* resolveRefs(term)     // Effect.serviceOption(toolRef) per §2.2
  const linked = new Map<string, LinkedTool>(
    impls.map((impl) => [impl.name, { identity: {}, tool: toDynamicTool(impl), handler: impl.fn }]),
  )
  return linked
})

// Stage B (per provider turn): materialize = snapshot + toolkit for THIS turn.
const materialize = (linked: Map<string, LinkedTool>) => {
  const advertised = new Map(linked)          // turn-scoped snapshot
  const toolkit = Toolkit.make(...[...advertised.values()].map((l) => l.tool))     // Toolkit.d.ts:212
  const settle = (call: { name: string; id: string; params: unknown }) => {
    const now = linked.get(call.name)         // registry state at settlement time
    const seen = advertised.get(call.name)    // what the model was shown
    if (!seen)               return synthesizeError(call, `Unknown tool: ${call.name}`)
    if (!now)                return synthesizeError(call, `Stale tool call: ${call.name}`)
    if (now.identity !== seen.identity)
                             return synthesizeError(call, `Stale tool call: ${call.name}`)
    return runSettlePipeline(now, call)       // decode → intercept → handle → encode → bound
  }
  return { toolkit, settle }
}
```

Both staleness errors are **settlement results the model sees** (pairing
invariant), and both emit the distinct blocked-terminal Trace event (§2.3) — a
stale call is neither a failure nor a success.

When can identity actually change under us? (a) hot reload in `alchemy dev`
re-runs Stage A; (b) a per-iteration Scoped tool Layer (fresh sandbox per Ralph
iteration, §9.3) re-links per iteration; (c) a Ring DO resumes a parked turn after
a **redeploy** — the recovered checkpoint carries its `promptHash`, and a mismatch
with the deployed term already routes to policy (§2.4 durability doctrine).
Case (c) is where reference identity fails across processes; the durable
equivalent is the identity *fingerprint*: `hash(toolName, parametersJsonSchema,
description, implLayerId)` recorded in the turn's `ModelRequested` event, re-checked
at settlement after recovery. In-process, reference equality (theirs) suffices;
across recovery, the fingerprint is the same check made serializable —
consistent with "deterministic ids, never minted at emit time" (§2.3).

The permission-filtered materialization also maps: their
`materialize(agent.permissions)` deleting wholly-denied tools (`registry.ts:112-113`)
is our capability-denial-by-omission at a finer grain — the charter already omits
un-granted refs (type-level, §1.2), and the `ToolInterceptor` handles the dynamic
residue.

---

## 7. Compaction as a durable two-event checkpoint

### 7.1 What OpenCode does

`compaction.ts`:

- **Threshold**: before executing the pending turn, estimate the full request
  (system + messages + tools) and compact if it exceeds
  `context − max(outputAllowance, buffer 20k)` (`:225-236`).
- **Two events, only the second projects**: publish `Compaction.Started`; stream a
  summary request (`Message.user(summaryPrompt)`, no tools, bounded
  `maxTokens`); on any provider error / empty summary return `false` — the
  previous boundary stays active; on success publish `Compaction.Ended`
  `{ text: summary, recent }` (`:186-223`). Crash between the two events = no
  boundary movement. Full transcript stays durable; compaction moves the
  *model-visible* boundary only.
- **Rolling summary**: the prompt embeds the previous summary (`<previous-summary>`
  … "update the anchored summary … preserve still-true details, remove stale
  details, merge new facts", `:161-168`) plus the previous `recent` text and the
  newly-cut head; the recent tail is preserved verbatim with a token budget
  (`select`, `:128-159`). The template (Objective / Important Details / Work State
  Completed-Active-Blocked / Next Move / Relevant Files) is fixed (`:16-46`).
- **Overflow recovery**: if the provider rejects with context overflow *before any
  durable assistant output*, run `compactAfterOverflow` once and rebuild the same
  logical turn through a path that cannot recover a second overflow
  (`runAfterOverflowCompaction` dies with "Post-compaction provider attempt cannot
  recover another overflow", `llm.ts:355-367`); the overflow error itself is
  swallowed only in that case (`llm.ts:236-241,282-289`).
- **Control flow**: both restarts are **typed defects** (`TurnTransitionError`)
  thrown through the stream stack and caught by `Effect.catchDefect` wrappers that
  re-enter `runTurn` (`llm.ts:152-166,355-381`) — their own report calls this
  "slightly smelly": "restart this turn from rebuilt history" didn't fit a linear
  pipeline, so they escaped through the defect channel.

### 7.2 Our mapping — fold-variant + step-machine phase, no defects

Compaction is a **`ContextPolicy` Layer** (§2.6/§3.2), one fold variant among
`truncate`/`tiered`/OM. Its mechanics on effect/ai are trivial — one extra
`streamText` with no toolkit:

```ts
const summarize = Effect.fn(function* (input: {
  previousSummary: string | undefined
  head: string
  recent: string
  maxTokens: number
}) {
  const parts = yield* LanguageModel.streamText({
    prompt: Prompt.make(buildRollingPrompt(input)),       // their template, shipped as default (§9.3)
    // no toolkit, no toolChoice — plain text
  }).pipe(Stream.runCollect)
  // collect text-deltas; empty/errored ⇒ typed CompactionFailed, boundary unmoved
})
```

The durable protocol becomes two `KernelEvents` with the §2.3 discipline:

- `CompactionStarted { v: 1, id: det(term, session, foldOrdinal), durable: true }`
- `CompactionEnded { …, payload: { summary, recentBoundarySeq, promptHash } }`

and the rule "only ended projects" is enforced *structurally* by repair-on-read:
the prompt-assembly pass replaces everything before `recentBoundarySeq` with the
summary **iff** a `CompactionEnded` exists; a dangling `CompactionStarted` changes
nothing. Fold-effectiveness is transactional because the event commit *is* the
effectiveness (design insight 8i). Two of their invariants come along verbatim:
the fold owns the full content model (provider-native reasoning/tool payloads
never cross the boundary — serialized plain text only, their
`specs/v2/session.md:115`; concretely: strip `options.anthropic.info` /
`options.openai` reasoning metadata when serializing history into the summary
prompt), and the previous fold output is an explicit input (rolling update, 8ii).

**Replacing `TurnTransitionError`:** the defect-restart is exactly what a step
machine dissolves. Compaction points are *states*, not exceptions:

```ts
type Phase =
  | { _tag: "AssembleRequest"; step: number; overflowRetried: boolean }
  | { _tag: "Compacting";      resume: { step: number }; reason: "threshold" | "overflow" }
  | { _tag: "AwaitModel";      step: number }
  | ...

// step-machine transitions (pure):
// AssembleRequest + estimate-over-threshold  → [Compacting(threshold), commands: [CallModel(summary)]]
// AwaitModel + ModelResponse(overflow error, nothing durable, !overflowRetried)
//                                            → [Compacting(overflow, overflowRetried: true), [CallModel(summary)]]
// AwaitModel + ModelResponse(overflow error, overflowRetried)   → [Failed, [Emit(BudgetExceeded-adjacent terminal)]]
// Compacting + ModelResponse(summary ok)     → [AssembleRequest(resume.step), [Emit(CompactionEnded), Checkpoint]]
// Compacting + ModelResponse(summary failed) → [AssembleRequest(resume.step), []]   // boundary unmoved; proceed or park per policy
```

The one-retry overflow rule is the `overflowRetried` flag — a serializable field
instead of a recursion depth through `catchDefect`. What their defect bought
(unwinding a half-built provider request) we get from the machine shape: the
request is assembled *inside* `AssembleRequest`, so "rebuild from compacted
history" is just re-entering that state after repair-on-read sees the new
`CompactionEnded`. Crash mid-`Compacting` recovers to `AssembleRequest` (dangling
`Started` is inert) — same guarantee, no control-flow exotica, and the state
survives `structuredClone` (§2.4 purity checklist).

The token estimate needs `context`/`output` limits per model — OpenCode reads
`model.route.defaults.limits` from their catalog. **effect/ai has no model
catalog**; see gap G3.

---

## 8. Their LLM-layer reasons vs effect/ai — the audit

OpenCode v2 wrote `@opencode-ai/llm` (protocol/route/provider split) instead of
staying on the Vercel AI SDK. Reasons, from their specs, checked one-by-one
against effect/ai + the beta providers:

### 8.1 Provider-native continuation metadata replay — **satisfied**

- Anthropic thinking: signatures round-trip through part options. Capture:
  response conversion stores `options.anthropic.info = { type: "thinking",
  signature }` / `{ type: "redacted_thinking", redactedData }`
  (`AnthropicLanguageModel.ts:1661-1678`, streaming `:2249-2267`). Replay: when
  assembling requests, a reasoning part with `info` present becomes a `thinking` /
  `redacted_thinking` block with the signature (`:1080-1098`). The module
  augmentation is explicit about why: *"cryptographically verifies that thinking
  content was indeed generated by Anthropic's API"* (`:225-237`).
- OpenAI Responses: `previous_response_id` is set from
  `ProviderOptions.previousResponseId` (`OpenAiLanguageModel.ts:629`), driven by
  the `ResponseIdTracker` service (`ResponseIdTracker.d.ts:28-80`) which prepares
  `{ previousResponseId, incrementalPrompt }` (`LanguageModel.d.ts:437-444`).
  Reasoning: `store === false` ⇒ requests include `reasoning.encrypted_content`
  (`:883-884`) and encrypted content is replayed (`:1036-1052`); `store === true`
  ⇒ item-id references (`:1015-1034`).
- **Model-switch hygiene comes free**: metadata is namespaced per provider on
  part `options`; the Anthropic renderer reads only `options.anthropic`, OpenAI
  only `options.openai`. Cross-model continuation automatically omits foreign
  native metadata — their rule (`specs/v2/session.md:52`) enforced by structure.
  Caveat: Anthropic *drops reasoning entirely* when `info` is absent (`:1084`
  `isNotNullish` guard, with `// TODO: make sending reasoning configurable`), so
  after a switch reasoning is omitted rather than downgraded to plain text
  (OpenCode downgrades to text). Minor behavioral difference, not a gap.
- One caveat for us: `ResponseIdTracker` matches prompt prefixes by **object
  identity** (`markParts(parts: ReadonlyArray<object>, …)`,
  `ResponseIdTracker.d.ts:48`). Our repair-on-read rebuilds message objects every
  turn, so the tracker would never match and we'd silently send full prompts. If
  we want incremental Responses-API calls we must keep per-turn message-object
  identity stable within a drain, or write our own tracker keyed on deterministic
  ids. Off by default; fine.

### 8.2 Reasoning signatures — **satisfied** (same evidence as 8.1, Anthropic side).

### 8.3 Exact structured round-trips — **satisfied, and we barely use it**

`generateObject` builds `responseFormat: { type: "json", objectName, schema }`
(`LanguageModel.d.ts:410-416`) with per-provider `CodecTransformer`s
(`LanguageModel.d.ts:99-124`; provider-specific rewrites in
`AnthropicStructuredOutput` / `OpenAiStructuredOutput` modules — both exist in
`unstable/ai`), and failures decode as typed `AiError.InvalidOutputError` /
`StructuredOutputError` (`AiError.d.ts:646,715`). OpenCode instead forces a
synthetic tool call for uniformity (`llm/src/llm.ts:146-149` per their report).
Our loop doesn't depend on provider JSON modes at all — halt-as-tool (§9.3) *is*
the synthetic-tool-call strategy, and tool parameters decode through
Effect Schema. The only structured-output consumer left is the Check/judge, which
can use `generateObject` or a forced tool per model. No gap.

### 8.4 Retry / rate-limit control — **satisfied by inversion**

effect/ai deliberately ships **no retry policy** — every failure is a typed
`AiError` member: `RateLimitError` with optional `retryAfter: Duration` and
`isRetryable: true` (`AiError.d.ts:263,305-317`), `NetworkError.isRetryable`
transport-sensitive (`:64-76`), `QuotaExhaustedError` not retryable without user
action (`:344-361`), etc. OpenCode also *deferred* provider retry policy
("intentionally deferred… rather than hardcoding one default for every provider",
their `specs/v2/session.md:153`). For an Effect-native kernel this is the right
shape: retries are `Effect.retry` with schedules driven by `retryAfter`, owned by
the interpreter, budget-charged per attempt (§2.4 per-command accounting). The AI
SDK's sin was retrying *inside* the black box; effect/ai doesn't.

### 8.5 No-silent-downgrade — **mostly satisfied; one flagged softness**

Model/endpoint resolution fails typed (`AiError.UnsupportedSchemaError`,
`InvalidRequestError`, `ToolkitRequiredError` — `AiError.d.ts:779,539,1117`); there
is no cross-protocol fallback to downgrade because each provider package is one
protocol. The one genuine silent fallback found: incremental Responses-API calls
retry non-incrementally on `InvalidRequestError`
(`Stream.catchReason("AiError", "InvalidRequestError", …)` /
`Effect.catchReason`, `LanguageModel.js:452-462,530-541`). It's
correctness-preserving (full prompt resend) but cost-visible; our interpreter
should surface it as a Trace event if we ever enable the tracker. Verdict: pass.

### 8.6 Things they needed that effect/ai does NOT give us (inherit the gap)

- **Model catalog** — capabilities, context/output limits, cost tiers, variants
  (`ModelV2.Info`). effect/ai has none; `OpenAiLanguageModel.Config` /
  `AnthropicLanguageModel.Config` are raw request-param passthroughs
  (`OpenAiLanguageModel.ts:80-118`, `AnthropicLanguageModel.ts:77-105`). Our
  per-turn model choice (§2.4 "model is per-turn data") and the compaction
  threshold both need limits data. We build a small catalog seam (this was already
  design insight 14).
- **Token estimation** — they use a tokenizer + `Token.estimate`; effect/ai v4
  currently ships a `Tokenizer` tag but the OpenAI `modelWithTokenizer` is
  commented out (`OpenAiLanguageModel.ts:552-558`). Estimate-by-chars (their
  `Token.estimate` is exactly that) is the shippable default.
- **Durable event log / projection** — `Chat.Persistence` persists whole-history
  snapshots per `chatId` over `BackingPersistence` (`Chat.d.ts:471-581`): no
  sequences, no projectors, no tail. It is a toy relative to `EventV2` and must
  not be mistaken for a Trace substrate. Ours is the Ring DO; nothing to inherit.
- **Anthropic assistant-block cache breakpoints** — provider TODO
  (`AnthropicLanguageModel.ts:1061-1066`). Workaround: anchor on user/tool
  messages. Upstreamable.

### The blunt verdict

**effect/ai is safe to bet on for the kernel — with our architecture, not despite
it.** Every reason OpenCode had to abandon the AI SDK is either already solved in
effect/ai (native continuation metadata via namespaced part options; reasoning
signatures; typed structured output; typed retry-relevant errors; no silent
protocol downgrades) or is solved by the control inversion we were doing anyway
(`disableToolCallResolution` + our interpreter owns settlement, journaling, and
retries). The AI SDK's failure mode — an opaque loop you fight — is absent:
effect/ai's loop is optional and we opt out; what we consume is the part schema,
the prompt algebra, the toolkit, and per-provider request/response translation,
all of which are exactly the tedious 80% we don't want to own. The genuinely
missing pieces (model catalog, token estimation, event sourcing) are things
OpenCode ALSO built outside its LLM layer — they were never going to come from a
model-access library.

Risks to carry openly: (1) `unstable/ai` is unstable — the part schema and
provider packages move with effect betas, and we pin the `beta` dist-tag of the
providers, which is coupled to the exact effect version; (2) the approval-machinery
landmine (§5.2) means one invariant — *never `needsApproval`, never approval parts
in prompts* — must be enforced by a lint, or a future effect release could execute
tools behind our journal's back; (3) the Anthropic assistant-anchor TODO caps
cache-hit rates for assistant-heavy transcripts until upstreamed.

---

## Gap list

| # | Gap | Severity | Disposition |
|---|---|---|---|
| G1 | effect/ai approval pre-resolution executes tools even under `disableToolCallResolution` (`LanguageModel.js:613-651` before `:674`) | high (correctness) | kernel invariant + `AI.lint` rule: no `needsApproval`, no approval parts in kernel-built prompts; our Ask protocol instead (§5) |
| G2 | No model catalog (limits, capabilities, cost) in effect/ai | medium | small `ModelCatalog` seam of the harness; per-turn `CallModel` carries resolved model + limits (design insight 14) |
| G3 | No token estimation wired (OpenAI tokenizer commented out) | low | chars/4 estimate à la their `Token.estimate`; catalog carries context/output limits |
| G4 | `Chat.Persistence` is snapshot-per-chatId, not an event log | n/a | do not use; Trace is ours. `Chat` only for the in-memory dev kernel, if at all |
| G5 | Anthropic assistant-content `cache_control` TODO (`AnthropicLanguageModel.ts:1061-1066`) | low-medium | anchor breakpoints on user/tool messages; upstream PR |
| G6 | `ResponseIdTracker` keys on message object identity — incompatible with rebuild-from-Trace prompts (`ResponseIdTracker.d.ts:48`) | low | leave incremental mode off; optional custom tracker keyed on deterministic ids later |
| G7 | Provider betas pinned to exact effect beta (`peerDependencies: effect ^4.0.0-beta.93`) | medium (operational) | lockstep pinning in catalog; conformance suite as the upgrade gate |
| G8 | Anthropic drops reasoning parts lacking `options.anthropic.info` (no plain-text downgrade), `:1084` | low | matches our fold rule anyway (provider-native content never crosses boundaries); document |
| G9 | Preliminary tool results (`HandlerContext.preliminary`) have no durable slot in our Trace vocabulary yet | low | type as `durable: false` progress deltas under the tool's `callId` |

---

## Implementation order (feeds Phase-2 kernel + `CloudflareAgent.test.ts`)

Ordered so each step is testable against `AI.Kernel.memory` first and reused
verbatim by the Cloudflare harness (§2.6 conformance doctrine):

1. **Stream-part → KernelEvent translation** (§1, §3). Pure function
   `Response.StreamPart → KernelEvent[]` with durable/live split, deterministic
   ids, `FinishPart → usage` accounting. Property tests against hand-built part
   sequences; no provider needed. This is the smallest verified-API surface and
   everything else consumes it.
2. **The step machine with phases** (§1, §7). `StepState` (messages-as-trace-refs,
   budget, `Phase` incl. `Compacting`/`overflowRetried`), `step(state, feedback) →
   [state, Command[]]`, the pairing-invariant repair-on-read pass, steer-resets-
   budget, last-step `toolChoice:"none"` + `MAX_STEPS_PROMPT`. `structuredClone`
   conformance test.
3. **The turn interpreter over `streamText`** (§3). `disableToolCallResolution:
   true`, eager settlement on a `FiberSet`, uninterruptible publication,
   `raceFirst(join, awaitEmpty)`, interruption fills, reload-once. First live
   test: `AI.Kernel.memory` + one provider layer.
4. **Stage-A toolkit capture + staleness** (§6). Linked-tool identity, per-turn
   materialization, stale/unknown settlement synthesis, identity fingerprint in
   `ModelRequested`. Unit-testable with two swapped Layers.
5. **Admission ledger + Coordinator reduction** (§2). In-memory ledger for the
   memory kernel (admit/promote steer-vs-queue, idempotent receipts), then the
   Ring DO version (plane 1 + dirty bit + alarm) — this is the first piece that
   goes into `test/AI/fixtures/org/cloudflare/kernel.ts`'s `TODO(Phase 2)` holes
   and what `CloudflareAgent.test.ts` drives first (admit → drain → trace replay).
6. **Durable Ask** (§5). Pending-ask rows, signature verification, allow/decline/
   correct + "always" amendment sweep, the parked-`callId` exclusion in the
   crash sweep. Testable on the memory kernel with a scripted answerer; on
   Cloudflare via a webhook fixture.
7. **Compaction fold-variant + ContextPolicy default** (§7). Two-event protocol,
   rolling template (ship theirs), overflow one-retry via phase flag. Chaos test:
   kill between `Started` and `Ended`.
8. **Context Sources/Epochs** (§4). Source registry seam, `EpochInitialized` /
   `ContextUpdated` events, atomic snapshot advance, cache-anchor rendering
   (`options.anthropic.cacheControl`, `prompt_cache_key` via
   `withConfigOverride`). Cache-hit assertion (usage `cacheRead > 0`) as the
   live test.
9. **Model catalog seam + budget wiring** (G2/G3): limits for compaction
   thresholds, per-turn model resolution, usage-unknown policy.
10. **`AI.lint` rules from the gaps**: no `needsApproval` in kernel toolkits (G1),
    no approval parts in prompts, no `Chat` in harness code paths (G4).

Steps 1–4 are pure-ish and land in `packages/alchemy/src/AI/` behind the existing
`Kernel` tag; 5–8 are the harness halves that make
`test/AI/fixtures/org/cloudflare/` executable end to end.
