# Mapping the AI SDK's loop/tool/approval/streaming patterns onto effect v4 `unstable/ai`

Design-research report for the Alchemy AI kernel (Stage B of the interpretation pipeline, §2.2).
Studied 2026-07-08.

**Verified against** (every API claim below was checked in these files; citations are `file:line`):

- `effect@4.0.0-beta.93` — `node_modules/effect/dist/unstable/ai/{LanguageModel,Tool,Toolkit,Chat,Prompt,Response,AiError,Telemetry,Model,IdGenerator}.d.ts` and the shipped implementation `LanguageModel.js` (approval machinery lives there, not in a d.ts).
- `@effect/ai-anthropic@4.0.0-beta.75`, `@effect/ai-openai@4.0.0-beta.75` — `packages/alchemy/node_modules/@effect/ai-anthropic/dist/*`.
- Vercel AI SDK at `.vendor/ai` (ai 7.0.18, `LanguageModelV4`): `packages/ai/src/generate-text/{generate-text,stop-condition,prune-messages,collect-tool-approvals}.ts`, `packages/provider/src/language-model/v4/language-model-v4-usage.ts`.
- Prior-art reports: `designs/ai/reports/ai-sdk.md`, `designs/ai/reports/vercel-academy.md`; design doc §2.2/§2.4/§2.5/§9.3.

Citation shorthand: bare `LanguageModel.d.ts:…` etc. means `node_modules/effect/dist/unstable/ai/…`; `anthropic/…` means `packages/alchemy/node_modules/@effect/ai-anthropic/dist/…`; `.vendor/…` is the AI SDK clone.

---

## 0. The one structural fact everything below hangs on

**effect/ai has no multi-step loop.** One `LanguageModel.generateText`/`streamText` call is exactly one AI-SDK *step*: one provider request plus one round of tool-call resolution, then it returns (`LanguageModel.js:514-525` — provider call, `resolveToolCalls` once, return `[...content, ...toolResults]`). `Chat` adds history bookkeeping around the same single-step calls (`Chat.d.ts:66-269`); there is no `do/while`, no `stopWhen`, no step array anywhere in the module.

This is the best possible starting position for us: the AI SDK's `generate-text.ts:786-1351` do/while — the thing whose stop-condition semantics, `prepareStep` statefulness, and approval-restart subtleties produced four majors of churn — is **not supplied and therefore not imposed**. The §2.4 step machine owns continuation outright; effect/ai supplies the *step primitive* and (surprisingly complete) approval and streaming plumbing inside it. Everything in this report is "how to drive effect/ai's single step from our step machine without giving any of its lessons back."

A second load-bearing fact: `disableToolCallResolution` (`LanguageModel.d.ts:164-172`) lets the kernel choose, per call, between two execution regimes:

- **framework-resolved** (default): effect/ai executes toolkit handlers inside the step, with concurrency (`GenerateTextOptions.concurrency`, `LanguageModel.d.ts:159-162`), streaming preliminary results, and the whole approval machinery (§4 below) for free; handler errors join the effect's error channel or the result per `failureMode`.
- **self-resolved** (`disableToolCallResolution: true`): the step returns/streams raw `tool-call` parts and the kernel issues `CallTool` commands itself; the type system removes handler errors and services from the call (`ExtractError`/`ExtractServices` conditional on the flag, `LanguageModel.d.ts:355-377`).

Recommendation threaded through this report: **Phase-2 memory kernel uses framework-resolved with an instrumented handler wrapper** (cheapest correct; pairing, approvals, preliminary streaming all inherited), and **the Workflow-durability tier uses self-resolved** (journal `CallTool` before execution). Both regimes are the same types; the step machine's `Command` vocabulary doesn't change, only which interpreter executes `CallTool`.

---

## 1. The multi-step loop

### What the AI SDK does

The do/while continues while "all client tool calls got executed or denied, OR provider-deferred results are pending" AND no stop condition fired (`.vendor/ai/packages/ai/src/generate-text/generate-text.ts:1341-1351`). `StopCondition = ({steps}) => boolean | Promise<boolean>`; built-ins `isStepCount(n)` (equality, `steps.length === n`), `hasToolCall(...names)` (last step's calls), `isLoopFinished()` (constant false) (`stop-condition.ts:27-54`). Natural terminations are documented as: finish reason ≠ `tool-calls`, a tool without `execute`, a tool call needing approval (`stop-condition.ts:8-13`). The famous trap: `result.output` throws `NoOutputGeneratedError` unless the final `finishReason === 'stop'` — a tool-call halt produces a result whose typed output is a runtime throw.

### What effect/ai gives us

Nothing — correctly. The continuation decision is entirely ours. What effect/ai does supply per step:

- `finishReason: Response.FinishReason` on the response (`LanguageModel.d.ts:266-269`), enum `"stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown"` (`Response.d.ts:1632-1641`). Note `"pause"` — a finish reason the AI SDK doesn't have (semantics: "the model requested to pause execution"; used by provider-side deferred flows; treat as a park signal, not a halt).
- `toolCalls` / `toolResults` accessors (`LanguageModel.d.ts:258-265`), and in the stream, typed `tool-call` / `tool-result` / `tool-approval-request` parts (§5).
- `toolChoice: { tool: name }` and `"required"` (`LanguageModel.d.ts:212-217`) — the mechanism for the halt-as-tool bounded nag.

### The mapping

| AI SDK | Alchemy kernel |
|---|---|
| `stopWhen: isStepCount(n)` | per-turn step allowance (kernel default) + `AI.budget({ iterations })` at ring scale — a *ceiling* in the `Err` channel (`BudgetExceeded`), never the success path (`src/AI/Budget.ts:15-30`, `src/AI/Errors.ts:17-28`) |
| `stopWhen: hasToolCall("finalizeTask")` | halt-as-tool: `AI.until(schema)` compiles to a synthetic `resolve` tool (+ `give_up`), the Check grades it (§2.5, §9.3) — the *type* of the loop already knows the answer shape (`LoopOut`, `src/AI/Loop.ts:20-26`) |
| `stopWhen: isLoopFinished()` | `AI.never` (`Out = never`, `src/AI/Halt.ts:70-75`) or agent-default "no tool calls" |
| stop conditions as array (disjunction) | the kernel's internal halt evaluation is an ordered disjunction: halt-met / `Refused` / budget / interrupt — only the success arm is named in `Out` (`ai-sdk.md` Insight 3) |
| `result.output` throws on tool-call stop | **structurally impossible**: `dispatch` returns `Effect<Out, BudgetExceeded \| Refused>`; `Out` exists iff a `Halt` ref does; a run only resolves `Out` when the Check ratifies the `resolve` tool's schema-valid call. There is no "final structured parse conditioned on finishReason" step at all — the halt value arrives as validated tool params, and a schema-invalid `resolve` call bounces back to the model as an ordinary tool error for self-correction, rather than throwing at the caller. |

The AI SDK's continue-guard subtlety ("`stopWhen` only evaluated when the last step has tool results") also dissolves: our continuation decision is a total function of `StepState`, evaluated after *every* feedback, not entangled with a loop phase.

### The continuation decision as code (pure, per §2.4)

```ts
// Stage B — inside the pure step machine. No I/O, no clocks, no ids minted.
// Types referenced: Response.FinishReason (Response.d.ts:1632), our Command/Feedback (§2.4).

interface TurnState {
  readonly messages: Prompt.MessageEncoded[]      // serializable — encoded, never class instances
  readonly budget: BudgetState                    // decremented per feedback (§3)
  readonly stepsThisTurn: number
  readonly pendingAsks: ReadonlyArray<{ approvalId: string; toolCallId: string }>
  readonly haltTool: string | undefined           // "resolve" when AI.until is wired
}

const decide = (state: TurnState, fb: Feedback): readonly [TurnState, Command[]] => {
  // ordered disjunction — first arm wins
  // 1. interrupt / steer already normalized into fb by the interpreter
  if (fb._tag === "ModelResponse") {
    const s = accountUsage(state, fb.usage)                    // §3 — per-command, transactional
    if (overBudget(s.budget)) return [s, [Halt.budget(s.budget)]]
    if (fb.finishReason === "error") return [s, [Emit.modelError(fb), Halt.error(fb)]]

    // 2. approval requests park the run — never CallModel past an unanswered ask (§4, §7)
    if (fb.approvalRequests.length > 0) {
      return [{ ...s, pendingAsks: fb.approvalRequests },
              fb.approvalRequests.map((a) => Ask.approval(a))] // durable wait; answer re-enters as AskAnswer
    }
    // 3. halt-as-tool: a schema-valid `resolve` call ends the run via the Check
    const resolveCall = fb.toolCalls.find((c) => c.name === s.haltTool)
    if (resolveCall !== undefined) return [s, [Checkpoint(), HaltPending(resolveCall.params)]]

    // 4. natural termination: no tool calls => turn is over
    if (fb.toolCalls.length === 0) return [s, [Checkpoint(), Halt.turnDone(fb)]]

    // 5. otherwise: tool calls exist. Framework-resolved regime: results already
    //    arrived interleaved (fb.toolResults); self-resolved regime: emit CallTool.
    const unresolved = fb.toolCalls.filter((c) => !fb.toolResults.some((r) => r.id === c.id))
    if (unresolved.length > 0) return [s, unresolved.map(CallTool.fromPart)]
    return continueOrStop(s)                                    // all paired — next model step
  }
  if (fb._tag === "ToolResult") {
    const s = pairResult(accountToolUse(state, fb), fb)         // pairing bookkeeping keys on callId
    return allPaired(s) ? continueOrStop(s) : [s, []]
  }
  if (fb._tag === "AskAnswer") return resumeFromAsk(state, fb)  // §4 — appends approval-response part
  // Steered / Recovered per §2.4 (unchanged by this mapping)
  ...
}

const continueOrStop = (s: TurnState): readonly [TurnState, Command[]] =>
  s.stepsThisTurn >= s.budget.stepAllowance
    ? [s, [Halt.budget({ limit: "iterations", used: s.stepsThisTurn })]]
    : [{ ...s, stepsThisTurn: s.stepsThisTurn + 1 },
       [CallModel({ prompt: renderPrompt(s) /* repair → prune → cache-mark, §6 */ })]]
```

The AI SDK's "continue while executed tool calls exist" arm is our arm 5 + `continueOrStop`; its "pending deferred provider results" arm maps to `providerExecuted: true` tool calls whose results legitimately arrive later — the typed exemption to the pairing invariant (§2.4), visible in effect/ai as the `providerExecuted` flag on `ToolCallPart`/`ToolResultPart` (`Response.d.ts:877-880, 958-961`; the resolver skips them, `LanguageModel.js:1027-1029`).

---

## 2. `prepareStep` → per-turn `CallModel` data + the ContextPolicy seam

The AI SDK's `prepareStep` hook can swap model, tools, toolChoice, instructions, messages, sandbox, providerOptions per step, with carry-forward semantics that flipped between v6 and v7 (`ai-sdk.md` §2.1, Judgment 8). Our answer splits it along the line the design already drew: **anything that carries forward lives in `StepState`; everything else is per-turn data on `CallModel`**. effect/ai makes the split natural because every one of `prepareStep`'s powers is an *argument to the step call*, not a mutation of a loop:

| `prepareStep` power | effect/ai mechanism (verified) | who owns it |
|---|---|---|
| swap `messages` | `prompt` is a per-call `Prompt.RawInput` (`LanguageModel.d.ts:131-135`); we re-render from Trace every turn | ContextPolicy seam (§6) |
| swap `model` | provide a different `LanguageModel` layer per call — `Model.make(provider, name, layer)` is a Layer that also provides `ProviderName`/`ModelName` (`Model.d.ts:30-40, 104-116`); `AnthropicLanguageModel.model(id, config?)` (`anthropic/AnthropicLanguageModel.d.ts:694`); `Model.captureRequirements` pre-binds the provider client at link time so per-turn provision is pure `Effect.provide` (`Model.d.ts:39`) | `CallModel` data (§9.3 already adopted model-per-turn) |
| swap `tools` (subset) | `toolChoice: { oneOf: [...names], mode }` — effect/ai filters which tools are *sent to the provider* (`LanguageModel.d.ts:149-158`; filtering at `LanguageModel.js:489, 662`). No toolkit rebuild, no handler re-registration. | `CallModel` data |
| swap `tools` (different handlers) | `toolkit` is itself a per-call option (`LanguageModel.d.ts:137-140`); `Toolkit.merge` composes (`Toolkit.d.ts:270-274`). Passing a different `Toolkit.WithHandler` per iteration is just a different argument. | link stage builds them; `CallModel` picks |
| `toolChoice` / force a tool | `"auto" \| "none" \| "required" \| { tool } \| { oneOf }` (`LanguageModel.d.ts:212-217`) — used for the halt-as-tool bounded nag (`{ tool: "resolve" }` on the final allowed step) | step machine |
| `instructions` override | the rendered term is re-supplied as the system message every turn from the immutable term (§3.2: outside ContextPolicy's jurisdiction) | renderer |
| `providerOptions` | per-message/per-part `options` records on `Prompt` (module-augmented per provider — see §7 cache-control) + scoped config override: `AnthropicLanguageModel.withConfigOverride` merges onto the `Config` service for the duration (`anthropic/AnthropicLanguageModel.js:12-13, 261`; `Config` service merge order at `:119-124`) | ContextPolicy (placement) / kernel |

**Is a per-step tools swap cheap in the types?** Yes, with one caveat. The tools type parameter flows into `Response.StreamPart<Tools>` — a *statically different* toolkit per iteration would make the stream type change per iteration. The kernel doesn't care: terms compile to `Tool.dynamic` (runtime schemas — exactly what tagged-template terms are), so the kernel-side type is uniformly `Record<string, Tool.Any>` and the per-iteration swap is value-level. `Tool.dynamic` accepts either an Effect Schema or raw JSON Schema and supports `needsApproval` in its options (`Tool.d.ts:905-971`, approval option at `:956`).

The carry-forward bug class is dissolved rather than fixed: there is no hook whose overrides implicitly persist, because there is no loop for them to persist *into*. What persists is `StepState.messages` (trace-derived) — explicit, serializable, `structuredClone`-safe per §2.4.

```ts
// link stage (once per Layer construction): pre-bind models so per-turn choice is pure provision
const models = {
  default: yield* AnthropicLanguageModel.model("claude-sonnet-4-6").captureRequirements,
  judge:   yield* AnthropicLanguageModel.model("claude-haiku-4-5").captureRequirements,
}
// turn driver: model is per-turn data on CallModel — no Layer recomposition
const parts = LanguageModel.streamText({ prompt, toolkit, toolChoice }).pipe(
  Stream.provide(models[cmd.model]),   // Model IS a Layer (Model.d.ts:30)
)
```

---

## 3. Usage & budgets

### The shapes, side by side

AI SDK v4 (`.vendor/ai/packages/provider/src/language-model/v4/language-model-v4-usage.ts:6-59`):

```ts
inputTokens:  { total?, noCache?, cacheRead?, cacheWrite? }   // all number | undefined
outputTokens: { total?, text?, reasoning? }
raw?: JSONObject                                              // provider-shaped passthrough
```

effect/ai (`Response.d.ts:1655-1694`, class `Usage` at `:1707`):

```ts
inputTokens:  { uncached?, total?, cacheRead?, cacheWrite? }  // all UndefinedOr(Number)
outputTokens: { total?, text?, reasoning? }
// NO raw field. Docstring (Response.d.ts:1698-1702): additional provider usage
// "can generally be found under the provider metadata of the finish part".
```

Near-identical (`noCache` ↔ `uncached`), including the battle-tested honesty that every count is possibly absent. **The cache splits we need for `AI.budget({ usd })` are present in the type and actually populated by the Anthropic provider**: non-streaming maps `cache_creation_input_tokens → cacheWrite`, `cache_read_input_tokens → cacheRead`, `input_tokens → uncached`, `total = uncached + cacheWrite + cacheRead` (`anthropic/AnthropicLanguageModel.js:1236-1248`); streaming accumulates the same fields across events (`:1286-1300, 1369-1407`). Usage arrives on the `FinishPart` (`Response.d.ts:1739-1752`) and on `GenerateTextResponse.usage` (`LanguageModel.d.ts:270-273`).

### What's missing, and the escape hatch

1. **No `raw` usage field.** The escape hatch is real and verified: the Anthropic provider attaches the raw wire usage to the finish part's provider metadata — streaming finish metadata is `{ anthropic: { stopSequence, usage: rawUsage } }` (`anthropic/AnthropicLanguageModel.js:1390-1398`), non-streaming metadata carries `container`/`context_management` (`:1256-1260`). Our `ModelCompleted` Trace event must persist `finishPart.metadata` verbatim alongside the structured `Usage` — then nothing is lost even where the unified shape is lossy.
2. **No `{unified, raw}` finish reason.** `FinishReason` is the unified enum only (`Response.d.ts:1632-1641`); Anthropic's raw `stop_reason` is consumed by `resolveFinishReason` and — as far as I verified — *not* echoed into metadata (only `stopSequence` is). This is the one place effect/ai is strictly poorer than LanguageModelV4 (`language-model-v4-finish-reason.ts`; AI SDK Judgment 3: it took them two majors to learn this). **Flag for an upstream PR**: add the provider's raw stop reason to `FinishPartMetadata`. Until then our `ModelCompleted` event records the unified reason + whatever metadata exists, and accepts the loss.
3. **`outputTokens.text` / `outputTokens.reasoning` are `undefined` on Anthropic** (`anthropic/AnthropicLanguageModel.js:1249-1253` sets only `total`). Budgets must not depend on the text/reasoning split.
4. **No cost model anywhere.** Neither effect/ai nor the AI SDK meters dollars. The USD budget needs a price table keyed by `(provider, model)` — and effect/ai hands us the key for free: `Model.ProviderName` / `Model.ModelName` are services provided by every `Model` layer (`Model.d.ts:41-70`).

### Budget accounting sketch (per-command, transactional — §2.4/§9.3)

```ts
// interpreter side: on FinishPart (the only part carrying usage — Response.d.ts:1739)
const onFinish = Effect.fn(function* (part: Response.FinishPart) {
  const provider = yield* Model.ProviderName          // Model.d.ts:54
  const model = yield* Model.ModelName                // Model.d.ts:69
  const usd = price(provider, model, part.usage)      // uncached*in + cacheRead*inCached
                                                      // + cacheWrite*inWrite + total*out
  // Unknown-usage policy is DECLARED, not accidental (design §2.4):
  //   every field is `number | undefined` — policy ∈ {failClosed, failOpen, estimate(tokenizer)}
  yield* Trace.commit([
    modelCompleted({ usage: part.usage, reason: part.reason, metadata: part.metadata }),
    budgetDecrement({ tokens: part.usage.inputTokens.total, usd }),
  ]) // one transaction: decrement commits with the Trace write, ceilings may fire
})   // between any two commands — never only at iteration boundaries (pi #4325)
```

Verdict on the critical question: **yes, USD budgets are computable on effect/ai + Anthropic today**, with a declared policy for absent counts and our own price table. No structural gap; one upstream nicety (raw finish reason) and one hygiene rule (persist finish metadata).

---

## 4. Approval flow

### What effect/ai actually does (read from the implementation, not the docs)

`Tool.needsApproval: boolean | NeedsApprovalFunction` sits on the tool (`Tool.d.ts:222-232`); the function receives *decoded* params plus `{ toolCallId, messages }` and returns `boolean | Effect<boolean>` — an Effect with **no requirements channel** (`Tool.d.ts:104-133`), so policy services must be closed over at construction, not yielded.

The runtime protocol (all in `LanguageModel.js`) is, to a very close approximation, **the AI SDK's approval-as-message-parts protocol, natively implemented**:

1. **Trigger**: during tool-call resolution, `isApprovalNeeded` (`:956-969`) evaluates `needsApproval`. If true, the tool is **not executed**; instead a `tool-approval-request` response part `{ approvalId, toolCallId }` is emitted, with `approvalId` minted from the ambient `IdGenerator` service (`:1070-1078` generate; `:700-713` stream). The turn otherwise completes normally — the blocked call has *no result* in this turn.
2. **Park**: nothing in effect/ai waits. The caller (us) sees the request part; the loop-stops-naturally behavior is ours to enforce.
3. **Answer**: the caller appends a `tool` message containing `Prompt.ToolApprovalResponsePart { approvalId, approved, reason? }` (`Prompt.d.ts:599-612`) to the next call's prompt.
4. **Resolution on next call** (the `collectToolApprovals` dance, `:858-918`): requests are matched to responses by `approvalId` across the whole message history, `excludeResolved` skips pairs that already have a `tool-result` by `toolCallId`. Then, **before the model is called**: approved calls are executed (`executeApprovedToolCalls`, `:970-1004`); denials synthesize failure results `{ type: "execution-denied", reason }` with `isFailure: true` (`createDenialResults`, `:1006-1022`); both are appended as a `tool` message (`:469-476`), and all resolved approval artifacts are **stripped from the outbound prompt** (`stripResolvedApprovals`, `:919-955` — because e.g. OpenAI rejects approval items it never issued). In streaming, the pre-resolved results are re-emitted as stream parts so `Chat` persists them (`:636-651`).

So: **deny-as-typed-result is already effect/ai's behavior** — the model sees a real failure result for the denied call; the pairing invariant is preserved *provided an answer eventually arrives*.

### Divergences from the AI SDK, and from our Ask doctrine

| Concern | AI SDK | effect/ai | Alchemy |
|---|---|---|---|
| where policy lives | call-level `toolApproval` config (v7; tool-level deprecated, `tool.ts:105`) | **tool-level only** (`needsApproval`) — effect/ai is at the AI SDK's v5 position | Layer-level: the tool's *implementation layer* decides (autonomy dial); `needsApproval` is set by the **link stage**, closing over the ring's policy snapshot |
| authenticity | HMAC signing of approval ids (`generate-text.ts:359-364`) | **none** — `approvalId` is a plain generated id | we sign the Ask payload at the world surface and verify the answer *before* ever writing a `ToolApprovalResponsePart` (§9.3 "answers arrive over world surfaces") |
| failure of the policy check | n/a | **fail-open**: `isApprovalNeeded` is piped through `Effect.orElseSucceed(constFalse)` (`LanguageModel.js:969`) — a throwing `needsApproval` (or params that fail decode) means *no approval needed* and the tool **executes** | never rely on effectful `needsApproval` for safety; hard gates live in the handler wrapper (below), which fails closed |
| pending approvals with no toolkit | loop-level machinery | typed error `ToolkitRequiredError` if the resume call carries pending approvals but no/empty toolkit (`LanguageModel.js:396-404, 426-436`; `AiError.d.ts:1088-1117`) | conformance test: resuming a parked run must rebuild the same toolkit |
| durable wait | `WorkflowAgent` suspension | none | our `Ask` command — the whole point |

### The reconciliation design

Our `Ask` is *not replaced* by `needsApproval` — it rides on it. The division of labor:

- **effect/ai owns the in-turn mechanics**: emitting the request part instead of executing, matching answers, pre-executing approved calls, synthesizing `execution-denied`, stripping artifacts. We should not reimplement any of that.
- **The kernel owns the wait**: on seeing a `tool-approval-request` stream part, the step machine emits `Ask` (a durable Trace event with a **deterministic id** — see below), the turn ends, the run parks (`step.waitForEvent` / DO pending row per §3.2). Unrelated input during the pending ask is held (§9.3).
- **The Ask answer is verdict + optional amendment**: the *verdict* maps 1:1 onto `ToolApprovalResponsePart { approved, reason }`; the *amendment* (an "approved for session" / "never ask for this pattern" policy delta) is **ours alone** — persisted as fold-visible ring state, consumed at the next link/`needsApproval` closure rebuild. effect/ai never sees amendments; it only sees that `needsApproval` returns false next time.
- **Correction** (typed feedback re-entering the loop) is also ours: it becomes the next iteration's first input, not an approval response.

Deterministic ids: `approvalId` is minted via the `IdGenerator` **service** (`IdGenerator.d.ts:47-82`; the provider `make` requires it, `LanguageModel.d.ts:482-486`). We provide a deterministic layer — this is the difference between replay-idempotent Asks and duplicated ones:

```ts
// deterministic ids for everything effect/ai mints (approvalIds included)
const DeterministicIds = Layer.effect(IdGenerator.IdGenerator, Effect.gen(function* () {
  const ctx = yield* TurnContext          // (term, session, turn) — harness-provided
  let ordinal = 0
  return { generateId: () => Effect.sync(() => `${ctx.session}:${ctx.turn}:${ordinal++}`) }
}))
```

The Ask handler end to end:

```ts
// step machine (pure): approval request part observed in the model feedback
case "tool-approval-request":
  return [holdPending(state, part), [
    Emit(toolRequested(part.toolCallId)),           // ToolRequested BEFORE any gate (§2.3)
    Ask({ kind: "approval", id: part.approvalId,    // deterministic (IdGenerator layer)
          toolCallId: part.toolCallId, payload: describeCall(state, part.toolCallId) }),
  ]]

// interpreter: AskAnswer feedback arrives (signature already verified at the surface)
case "AskAnswer": {
  const answer = fb.verdict // "approve" | "deny" | "correct"
  if (answer === "correct") return reenterWithFeedback(state, fb.correction)
  const part = Prompt.makePart("tool-approval-response", {
    approvalId: fb.askId, approved: answer === "approve", reason: fb.reason,
  })                                                  // Prompt.d.ts:599-612, makePart :113
  const messages = [...state.messages, Prompt.makeMessage("tool", { content: [part] })]
  // amendment is fold-visible ring state; the NEXT link consumes it:
  const commands = fb.amendment ? [Emit(policyDelta(fb.amendment))] : []
  return [{ ...state, messages }, [...commands, CallModel({ ... })]]
  // next CallModel: effect/ai pre-executes approved calls / synthesizes
  // execution-denied results and strips artifacts (LanguageModel.js:455-488)
}
```

**Immediate policy denials** (interceptor blocks that need no human) bypass the approval protocol entirely: the handler wrapper synthesizes a result in the *same* turn, reusing effect/ai's denial vocabulary (`{ type: "execution-denied", reason }`-shaped failure) so the model sees one consistent language for "blocked" — this is the pairing invariant's policy-block arm (§2.4) and TeensyCode's "a blocked call must return a real result" (§7).

**Subagent composability** — the AI SDK's known failure (approvals don't work inside subagents, welded to the top-level message list). Ours composes by construction: each ring drives its own prompt, so an inner ring's approval request becomes an `Ask` event on *its* Trace, escalating to the parent as an ordinary `KernelEvent` trigger (§2.5 upward channel 2). Write the conformance test for exactly this (ai-sdk.md Insight 6).

---

## 5. Streaming protocol

### effect/ai's parts, enumerated (`Response.d.ts:109` — `StreamPart<Tools>`)

| part | id-keyed? | fields (verified) |
|---|---|---|
| `text-start` / `text-delta` / `text-end` | **yes** — `id` per text block (`:310-315, 356-365, 410-415`) | delta carries `{ id, delta }` |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | **yes** (`:514-519, 560-569, 614-619`) | same shape |
| `tool-params-start` / `-delta` / `-end` | **yes** — `{ id, name, providerExecuted }` then `{ id, delta }` (`:664-698, 734-743, 793-798`) | tool-input streaming |
| `tool-call` | `id` = call id (`:863-881`) | `{ id, name, params, providerExecuted }` |
| `tool-result` | `id` = call id (`:944-1008`) | `{ id, name, result, encodedResult, isFailure, providerExecuted, preliminary }` |
| `tool-approval-request` | `approvalId` + `toolCallId` (`:1164-1173`) | §4 |
| `file`, `source` (document/url) | file: no id; sources: `id` (`:1240-1461`) | attachments/citations |
| `response-metadata` | response `id` (`:1548-1565`) | `{ id?, modelId?, timestamp?, request? }` — sent early, separate from finish (same lesson as LanguageModelV4) |
| `finish` | n/a (`:1739-1752`) | `{ reason, usage, response?, metadata }` |
| `error` | n/a (`:1826-1828`) | **in-band** `{ error: unknown }` — multiple errors can stream (same as v4 spec) |

Plus: every part carries a `metadata: ProviderMetadata` record (`:165-175`) — the per-part provider escape hatch the AI SDK arrived at in v4.

**Conclusion: effect/ai already ships the id-keyed block algebra the AI SDK only reached in v5** (its most disruptive provider-facing rewrite, `ai-sdk.md` Judgment 6). Our `ModelDelta` design (`{blockId, blockKind, delta}`, §9.3/ai-sdk Insight 12) maps 1:1 with zero adaptation.

### KernelEvent mapping

Two contracts, per §2.3: durable events carry deterministic ids and `seq`; deltas are typed non-durable.

| StreamPart | KernelEvent | durable | id derivation |
|---|---|---|---|
| `response-metadata` | `ModelRequested`→`ModelResponded(modelId, responseId)` annotation | durable | `(session, turn)` — one per step |
| `text-start/-delta/-end`, `reasoning-*`, `tool-params-*` | `ModelDelta { blockId, kind, delta }` | **live-only** (`durable: false`, never advances the cursor) | `blockId` = the part's `id` (provider-scoped; prefix with `(turn, step)`) |
| block end (assembled) | `ModelBlock { blockId, kind, content }` — the kernel driver assembles deltas per `id` and commits one durable event per completed block | durable | `(session, turn, step, blockId)` |
| `tool-call` | `ToolRequested { callId, name, params }` — emitted **before any gate** (§2.3 ordering) | durable | provider `part.id` (stable across replay: it's in the transcript) |
| `tool-result` with `preliminary: true` | `ToolProgress` | live-only | callId + ordinal |
| `tool-result` final | `ToolCompleted` / `ToolFailed` (`isFailure`) — blocked/denied is the distinct `ToolDenied` variant when `result.type === "execution-denied"` | durable | `part.id` (callId) |
| `tool-approval-request` | `Escalated`/`Ask` | durable | `approvalId` (deterministic via our IdGenerator layer, §4) |
| `finish` | `ModelCompleted { reason, usage, metadata }` + budget decrement (same transaction, §3) | durable | `(session, turn, step)` |
| `error` | `ModelError` (turn continues or halts per step machine) | durable | `(session, turn, step, ordinal)` |
| `file` / `source` | `ArtifactProduced` | durable (content-addressed payload; fold owns preview-and-drillback, §9.4) | hash |

The `ModelBlock` row is the answer to the AI SDK's slice-loop stream-recovery problem (ai-sdk.md Insight 8): a subscriber that reconnects replays durable `ModelBlock`s (never a delta for a block whose start it missed), then tails live deltas. We journal *assembled blocks at block end*, not start-chunk preludes — the Trace **is** the stream, so replay is free and there is no separate `streamContext` to serialize.

Note on preliminary results: effect/ai itself filters `preliminary: true` results out of the durable-ish return value of `generateText` (`LanguageModel.js:516`) — same policy: only final results are authoritative (`Response.d.ts:962-975`).

---

## 6. `pruneMessages` / context management → the default ContextPolicy

What the AI SDK's `pruneMessages` teaches (verified in `.vendor/ai/packages/ai/src/generate-text/prune-messages.ts`): prune tool call/result/approval content by recency and tool name; **pair-atomicity requires global (cross-message) id→name maps** because a `tool-approval-response` lives in a different message from its request — per-message resolution produced orphaned approvals (comment at `:103-109`); kept-message scan collects `toolCallId`s *and* `approvalId`s first (`:79-96`); the original prompt always survives; `Object.create(null)` maps for attacker-supplied ids (`collect-tool-approvals.ts:42-65`).

On effect/ai the substrate is `Prompt` — `{ content: ReadonlyArray<Message> }` (`Prompt.d.ts:1278-1284`), messages `system | user | assistant | tool` each with typed parts and an `options` record, constructors `Prompt.make/fromMessages/concat/empty` (`:1346-1466`), `makeMessage`/`makePart` (`:810, 113`). Everything is plain data with schemas — a pure `Prompt → Prompt` function is trivially testable and serializable. `Chat` (`Chat.d.ts:66-115`) holds history in a `Ref<Prompt>` with `export/exportJson` — but our Trace is the source of truth and the prompt is *re-derived* every turn (repair-on-read, §2.4), so **we use `Prompt` directly and skip `Chat`**; `Chat.fromExport`'s schema'd snapshot format remains interesting only as prior art for fold checkpoints.

The normative pipeline (§3.2): `fold → render → repair → prune → markCacheBoundaries → CallModel`.

```ts
// ContextPolicy.truncate — the default. Pure; property-tested per §2.4.
const truncate = (prompt: Prompt.Prompt, opts: { keepLast: number }): Prompt.Prompt => {
  const msgs = prompt.content
  // (0) REPAIR-ON-READ already ran: every tool-call in msgs has a result or a
  //     deterministic synthetic fill; provider-executed deferreds are exempt.
  // (1) global pairing maps — the AI SDK's hard-won lesson, verbatim
  const keep = new Set<string>()            // toolCallIds + approvalIds to retain
  for (const m of msgs.slice(-opts.keepLast))
    for (const p of m.content as any[]) {
      if (p.type === "tool-call" || p.type === "tool-result") keep.add(p.id)
      if (p.type === "tool-approval-request" || p.type === "tool-approval-response")
        keep.add(p.approvalId)              // pairs are atomic: request+response+result live or die together
    }
  // (2) prompt-preserving: system (the rendered term — outside our jurisdiction
  //     anyway, §3.2) and the originating user/work-item message always survive
  const pruned = msgs.map((m, i) =>
    i === 0 || m.role === "system" || i >= msgs.length - opts.keepLast
      ? m
      : Prompt.makeMessage(m.role, {
          content: (m.content as any[]).filter((p) =>
            p.type === "tool-call" || p.type === "tool-result" ? keep.has(p.id)
            : p.type.startsWith("tool-approval-") ? keep.has(p.approvalId)
            : true),
          options: m.options,               // NEVER drop options — cache marks ride here
        }),
  ).filter((m) => m.content.length > 0)     // remove emptied messages (their default too)
  return Prompt.fromMessages(pruned)
}

// (3) prune THEN cache — the ordering law (Academy: "pruning changes how many
//     messages there are"). Anthropic breakpoints are per-message options:
const markCacheBoundaries = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(prompt.content.map((m, i, all) =>
    i === 0 || i < all.length - 2       // stable prefix; last 2 stay unmarked
      ? Prompt.makeMessage(m.role, { content: m.content as any, options: {
          ...m.options,
          anthropic: { cacheControl: { type: "ephemeral" } },  // verified: §7
        }})
      : m))
```

Property tests (conformance suite): for arbitrary trims — no orphaned `tool-call`/`tool-result`/approval triple in the rendered prompt; head-of-transcript stability (byte-equal prefix ⇒ cache hit); composition with repair-on-read (a synthetic interrupted result counts as the pair's result).

**A genuinely new option effect/ai's Anthropic provider exposes**: server-side context management. `Config.context_management` supports `compact_20260112` (provider-side compaction with trigger thresholds and `pause_after_compaction`) and `clear_tool_uses_20250919` / `clear_thinking_20251015` edits (`anthropic/AnthropicLanguageModel.d.ts:37-74`), and the raw response's `context_management` comes back in finish metadata (`AnthropicLanguageModel.js:1258-1260`). That is a whole ContextPolicy implementation living in the provider — ship it as `ContextPolicy.anthropicNative`, an alternative Layer (with the caveat that provider-side compaction is invisible to the fold; the Trace still holds ground truth).

---

## 7. TeensyCode harness lessons on this stack

**Bounded tool output.** Two layers, both ours (effect/ai imposes no caps anywhere):

```ts
// layer 1: the tool implementation (contract prose documents the cap — USAGE section)
// layer 2: the kernel handler wrapper — the backstop that runs for EVERY tool,
// inside Toolkit.toLayer's handlers (HandlersFrom signature: Toolkit.d.ts:124-126)
const instrument = <A>(name: string, handler: Handler<A>): Handler<A> =>
  (params, ctx) => Effect.gen(function* () {
    yield* Interceptor.check(name, params)             // may fail -> becomes typed result (below)
    const result = yield* handler(params, ctx).pipe(Effect.timeout(toolTimeout))
    return capBytes(result, TOOL_RESULT_BYTE_BUDGET)   // cap + ANNOUNCE + paginate hint —
  })                                                   // silent truncation is worse than none
```

Crucial pairing with effect/ai's error model: kernel tools are built with **`failureMode: "return"`** (`Tool.d.ts:81-96`) so a handler failure — including an interceptor block or a timeout — is *captured into the tool result* (`FailureResult` includes `AiError` under `"return"`, `Tool.d.ts:641`) and fed back to the model, instead of failing the whole `generateText` effect (which is what the default `"error"` mode does via `HandlerError → ExtractError`, `LanguageModel.d.ts:342, 355-362`). `failureMode: "return"` **is** "tool errors are model-visible results" (ai-sdk.md Insight 13) as a single constructor argument.

**The needsApproval confabulation trap.** The Academy's exact bug ("the tool call disappears; the model makes one up") maps onto effect/ai like this: when `needsApproval` fires, the turn's transcript contains a `tool-call` with **no `tool-result`** — only a `tool-approval-request` part. effect/ai synthesizes the real result *at the next call* (`executeApprovedToolCalls` / `createDenialResults`, `LanguageModel.js:970-1022`), **but only if a `tool-approval-response` part is present**. The hook, precisely: *the blocked call's result is synthesized in `collectToolApprovals` resolution on the next `generateText`/`streamText` invocation* — there is no in-turn synthesis. Therefore three kernel rules make the trap structurally impossible:

1. The step machine never issues `CallModel` while the rendered prompt contains an approval request without a matching response part (arm 2 of `decide`, §1) — the loop *parks*, it does not continue.
2. An abandoned ask (interrupt, timeout, run teardown) is settled by repair-on-read as a deterministic synthetic denial (`execution-denied`-shaped, "interrupted awaiting approval") so the pairing invariant holds across recovery.
3. ContextPolicy pruning treats request/response/result as one atomic triple (§6) — pruning can never manufacture an unanswered request.

Plus the fail-open footgun from §4: `isApprovalNeeded` swallows errors as "no approval needed" (`LanguageModel.js:969`) — hard safety gates therefore live in the fail-closed handler wrapper, and `needsApproval` is only the *routing* signal for the Ask protocol.

**Approval config union (`interactive` / `background` / `delegated`).** Data, not code — and in our stack it is *Layer parameters*, resolved at link time into the `needsApproval` closure and the interceptor:

```ts
type ApprovalConfig =
  | { mode: "interactive" }                       // Ask a human (channel-paired Layer)
  | { mode: "background" }                        // auto-approve; Trace still records ToolRequested
  | { mode: "delegated"; trust: readonly string[] } // subagent inherits a trust slice

const BashApproval = (config: ApprovalConfig) =>
  Layer.effect(BashPolicy, Effect.succeed({
    needsApproval: (params: { command: string }) =>
      config.mode === "background" ? false
      : config.mode === "delegated" ? !config.trust.some((p) => params.command.startsWith(p))
      : !onSafelist(params.command),
  }))
// link stage: Tool.dynamic("Bash", { ..., needsApproval: policy.needsApproval })
```

Serializable across the ForkLoop boundary (the Academy's stated reason for data-not-functions), and `delegated.trust` is exactly the child-budget-lease pattern applied to authority.

**Cache-control marking through providerOptions — verified.** The Anthropic provider supports breakpoints at every granularity we need:

- per-message: `SystemMessageOptions` / `UserMessageOptions` / `AssistantMessageOptions` / `ToolMessageOptions` are module-augmented with `anthropic: { cacheControl: CacheControlEphemeral | null }` (`anthropic/AnthropicLanguageModel.d.ts:199-262`);
- per-part: `TextPartOptions.anthropic.cacheControl` (`:271-283`);
- request-level: `Config.cache_control` with `ttl: "5m" | "1h"` (`:33-36`), and a `system` array whose blocks each accept `cache_control` (`:104-115`).

So `markCacheBoundaries` (§6) writes plain data onto `message.options` — no provider API call, no middleware. The prune-then-cache ordering and "recent messages stay unmarked" rules are ContextPolicy code, as sketched.

---

## 8. Telemetry

effect/ai's story is **spans, not an event channel**: every provider call receives a `Span` in `ProviderOptions` (`LanguageModel.d.ts:433-436`); the `Telemetry` module supplies GenAI semantic-convention attribute types and `addGenAIAnnotations(span, options)` (`Telemetry.d.ts:30, 384-461`); providers ship their own attribute extensions (`anthropic/AnthropicTelemetry.d.ts:56-62` adds `cacheCreationInputTokens`/`cacheReadInputTokens`). The extension seam is `Telemetry.CurrentSpanTransformer` — a context service whose function receives the full `ProviderOptions` **plus the response parts** after each call (`Telemetry.d.ts:489-513`; invoked at `LanguageModel.js:1134-1141`).

The division that avoids double instrumentation:

- **effect/ai owns the model-call span.** The kernel never emits a second `gen_ai.*` span for `CallModel`. Instead it (a) wraps each turn in its own kernel span (`Effect.withSpan("ai.turn", …)`) so the provider span nests under it, and (b) provides one `CurrentSpanTransformer` layer that stamps ring provenance — `{ ring, term: promptHash, session, workItem, cause, auth }` — onto the model span. That is the whole integration; no exporter code.
- **The Trace owns durable truth.** `KernelEvent`s (§2.3) are not OTel spans and are not emitted *as* telemetry; the OTel exporter over the Trace (Phase-3 `TraceStore` deliverable) exports **kernel-level** events only — `TurnStarted/Ended`, `ToolRequested/Completed/Denied`, `IterationFolded`, `Ask/Escalated`, `BudgetExceeded` — i.e. everything effect/ai *cannot* see. `ModelRequested/ModelCompleted` Trace events reference the model span's `traceId/spanId` (captured from the ambient span at command time) rather than duplicating its attributes.
- **Redaction**: the AI SDK's restricted-dispatcher lesson (redact user context by default) lands in two places — the span transformer writes provenance ids, never payloads; and Trace redaction classes exist in the event schema from v1 (§2.3, already specified).

One gap to note: the AI SDK v7's typed telemetry *event channel* (`generateText`/`step`/`languageModelCall`/`executeTool` events with per-step perf metrics like tokens/sec and `toolExecutionMs`) has no effect/ai counterpart. We don't need the channel (the Trace is our channel), but the **perf metrics** are worth copying: the interpreter annotates `ModelCompleted` with `timeToFirstOutput`/`tokensPerSecond` computed interpreter-side (never inside `step` — purity, §2.4), and `ToolCompleted` with `toolExecutionMs`.

---

## Gap list — what effect/ai lacks (vs the AI SDK and vs our doctrine)

**We must build (by design — the kernel's job):**

1. **The loop itself**: continuation decision, step allowance, halt-as-tool compilation, Check/Fold invocation, steer/interrupt handling. effect/ai is single-step by construction.
2. **Durable waits**: nothing in effect/ai parks. `Ask` (park-until-correlated-answer), including timeout escalation and abandoned-ask settlement.
3. **ContextPolicy**: no `pruneMessages` equivalent, no compaction, no cache-boundary marking. We build `truncate` (§6) with the AI SDK's pair-atomicity spec; `ContextPolicy.anthropicNative` over `Config.context_management` is a cheap second Layer.
4. **Budget enforcement + price table**: no cost metering anywhere in effect/ai (nor the AI SDK). Keyed by `Model.ProviderName`/`ModelName`; declared unknown-usage policy.
5. **Tool-output byte caps, per-tool timeouts, interception**: effect/ai has no per-tool `timeout` (the AI SDK does) and no interceptor; all live in our handler wrapper (fail-closed).
6. **Ask/approval signing**: no HMAC anywhere in effect/ai's approval flow; we sign/verify at the world surface.
7. **Stream recovery**: no slice-loop/`streamContext` equivalent; solved by durable assembled `ModelBlock` events (§5) — Trace-as-stream.
8. **Telemetry perf metrics + Trace exporter**: spans exist; the event channel, restricted-by-default redaction, and per-step perf numbers are ours.

**Work around (effect/ai has it, shape differs from our doctrine):**

9. **Approval policy is tool-level** (`needsApproval`), the position the AI SDK abandoned in v6/v7 for call-level config. Workaround: link-stage closes ring policy into `needsApproval`; amendments trigger closure rebuild. Acceptable because our policy source is the Layer graph, not the call site.
10. **`isApprovalNeeded` fails open** (`Effect.orElseSucceed(constFalse)`, `LanguageModel.js:969`) and `NeedsApprovalFunction` has no requirements channel (`Tool.d.ts:120`). Workaround: `needsApproval` is routing only; safety gates are wrapper-side and fail closed.
11. **`ToolkitRequiredError` on resume**: a resumed prompt with pending approvals requires a non-empty toolkit (`LanguageModel.js:396-404`). Kernel obligation: rebuild the identical toolkit on recovery (promptHash-checked, §9.3 checkpoint-fossil rule).
12. **In-band `error` parts are `unknown`** (`Response.d.ts:1826-1828`): narrow before use; map to `ModelError` events with the raw payload preserved.
13. **`"pause"` finish reason** (`Response.d.ts:1639`) has no documented driver-side contract; treat as park-and-await-provider (aligned with provider-deferred tools) and cover with a conformance test once a provider actually emits it.

**Upstream PR candidates (information effect/ai drops that we cannot reconstruct):**

14. **Raw finish reason**: `FinishReason` is unified-only; Anthropic's raw `stop_reason` is not preserved in finish metadata (only `stopSequence` is — `anthropic/AnthropicLanguageModel.js:1390-1398`). The AI SDK needed two majors to learn `{unified, raw}`; propose adding the raw reason to `FinishPartMetadata`.
15. **`Usage.raw`**: absent as a field, but Anthropic already stuffs raw usage into finish metadata (`:1395-1398`), so the *information* survives — the PR would standardize where. Until then: persist `FinishPart.metadata` verbatim on `ModelCompleted` (kernel hygiene rule).
16. **`outputTokens.text/reasoning`** unpopulated by Anthropic (`:1249-1253`) — provider-side fix, low priority (budgets use totals).

**Genuinely already-solved by effect/ai (do not rebuild):** id-keyed block streaming (§5), approval request/response/pre-execution/denial-synthesis/artifact-stripping (§4), deny-as-typed-result (`execution-denied`), preliminary tool results, per-part provider metadata, per-message cache breakpoints, `toolChoice.oneOf` tool gating, deterministic-id seam (`IdGenerator` as a service), model-as-Layer with name services, prototype-pollution-safe JSON parsing for tool args (`Tool.unsafeSecureJsonParse`, `Tool.d.ts:1359-1376`).

---

## Implementation order → `packages/alchemy/test/AI/CloudflareAgent.test.ts`

Ordered so each step is testable against `AI.Kernel.memory` before the Cloudflare harness exists, and each unlocks the next test scenario:

1. **`DeterministicIds` layer** (`IdGenerator`) + `TurnContext`. *Test: two replays of the same recorded turn mint identical approvalIds/blockIds.*
2. **Link stage — tool compiler**: term `Tool` → `Tool.dynamic` (description = rendered template, params from `Parameter` refs, `failureMode: "return"`) + `Toolkit.make` + the instrumented-handler wrapper (byte caps, timeout, interceptor, budget tick, `ToolRequested`-before-gate emission). *Test: a blocked call yields a model-visible `execution-denied`-shaped result; an oversized result is capped with an announcement.*
3. **Stage-B turn driver**: `LanguageModel.streamText` (framework-resolved) → StreamPart→KernelEvent mapping (§5) with per-block delta assembly and durable `ModelBlock`/`ModelCompleted` commits; pairing repair-on-read as a pure `Prompt` normalization. *Test: property — arbitrary mid-stream cut produces a Trace from which repair renders a prompt with zero orphans.*
4. **Continuation decision** (§1) + halt-as-tool: synthetic `resolve`/`give_up` tools from `AI.until(schema)`, bounded nag via `toolChoice: { tool: "resolve" }`, `Refused` on ratified give-up. *Test: the `result.output`-throws scenario — a run halted by tool call resolves `dispatch` with the schema-typed value; schema-invalid `resolve` bounces as tool error.*
5. **Budget accounting**: `FinishPart.usage` → per-command transactional decrement, price table over `Model.ProviderName/ModelName`, declared unknown-usage policy. *Test: ceiling fires between two tool commands mid-turn, `BudgetExceeded` carries `{limit, used, resumeHint}`, re-dispatch continues from the fold.*
6. **Ask protocol** (§4): approval request → durable park → verdict+amendment answer → `ToolApprovalResponsePart` resume; abandoned-ask synthetic denial; amendment as fold-visible policy delta consumed by re-link. *Test: approve-later resumes and executes exactly once (dedupe by `toolCallId`); deny produces model-visible denial; kill-mid-park recovers via `Resume` with the ask intact.*
7. **`ContextPolicy.truncate`** (§6) + `markCacheBoundaries` (Anthropic breakpoints). *Test: pair-atomicity property; prune-then-cache ordering; byte-stable prefix across three turns.*
8. **Model-per-turn**: `captureRequirements`-prebuilt Model layers, `CallModel.model` selection, `withConfigOverride` for per-turn knobs. *Test: Judge turn runs on haiku while Engineer runs on sonnet in one interpreted loop, asserted via `Model.ModelName` in the Trace.*
9. **Telemetry wiring** (§8): kernel turn span + `CurrentSpanTransformer` provenance stamp; perf annotations on `ModelCompleted`/`ToolCompleted`. *Test: exactly one `gen_ai.*` span per model call (no double instrumentation), carrying ring/session attributes.*
10. **`CloudflareAgent.test.ts`**: deploy the `test/AI/fixtures/org/cloudflare/` worker with the memory-kernel driver embedded in the Ring DO; scenarios in order — (a) dispatch → multi-step turn → halt-as-tool resolution over real Anthropic; (b) tool denial visible to model; (c) Ask parked across a DO eviction, answered via HTTP route, run resumes; (d) budget ceiling parks resumably; (e) trace replay-then-tail equals live event log minus deltas. Steps 1–7 are prerequisites; 8–9 can land after (a).

---

## Honesty notes

- Everything cited from `LanguageModel.js` is shipped implementation, not public d.ts contract — the approval flow's internals (`collectToolApprovals`, `stripResolvedApprovals`, fail-open `isApprovalNeeded`) could change under the `unstable` banner; the conformance suite should pin the observable behavior (request part emitted, approved-executes/denied-synthesizes on next call, artifacts stripped).
- I did not run any code; claims about Anthropic usage mapping and cache options come from reading the provider source/d.ts, not live calls.
- `@effect/ai-openai` was located but not read in depth; the OpenAI-specific approval threading (`previousResponseId`/`incrementalPrompt`, `ResponseIdTracker`) was noted in passing (`LanguageModel.js:370-411`) and matters for the OpenAI provider's incremental-prompt mode — unverified beyond existence.
- The `"pause"` finish reason and provider-deferred tool results are typed but I found no in-repo driver exercising them; gap item 13 stands.
- `Chat.Persisted`/`BackingPersistence` (`Chat.d.ts:471-581`) was judged out of scope (our Trace supersedes it) after reading, not skipped.
