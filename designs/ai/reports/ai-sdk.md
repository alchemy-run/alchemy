# Vercel AI SDK — study for Alchemy AI

Subject: `vercel/ai` at commit `5f0d553` (main, Jul 8 2026, package `ai@7.0.18`, provider spec `LanguageModelV4`).
Clone: `.vendor/ai`. All `file:line` citations below are relative to `.vendor/ai/`.

A note on versions: the task brief mentions "LanguageModel v2/v3" — the repo has since moved on. The spec is now at **v4** (`packages/provider/src/language-model/{v2,v3,v4}`), the agent class is **`ToolLoopAgent`** (v6 renamed it from `Experimental_Agent`), and v7 is the current major. The v5/v6/v7 migration guides are all in-repo (`content/docs/08-migration-guides/`) and are used heavily in the Judgments section.

---

## 1. Architecture overview

The monorepo has one core, one pure spec, and everything else is a consumer or an adapter:

| Layer | Packages | Role |
|---|---|---|
| **Spec (pure types)** | `packages/provider` | Versioned interfaces: `LanguageModelV{2,3,4}`, embedding/image/speech/etc. models, shared provider metadata, the error taxonomy. Zero runtime beyond error classes. |
| **Shared runtime utils** | `packages/provider-utils` | `tool()` and the `Tool` union, `FlexibleSchema` (zod/valibot/JSON-schema), message types (`ModelMessage`), fetch/retry/id helpers. |
| **Core** | `packages/ai` | `generateText`/`streamText` (the loop lives here: `src/generate-text/`), `ToolLoopAgent` (`src/agent/`), middleware (`src/middleware/`), registry (`src/registry/`), the UI message stream protocol (`src/ui-message-stream/`), `useChat` plumbing (`src/ui/`), telemetry channel (`src/telemetry/`). |
| **Providers** | ~40 packages (`anthropic`, `openai`, `google`, `amazon-bedrock`, …) | Each implements `LanguageModelV4` (or an older spec version — the core up-converts). |
| **Gateway** | `packages/gateway` | Vercel AI Gateway provider; it is the **global default**: plain-string model ids resolve through it (`packages/ai/src/model/resolve-model.ts:30-32`). |
| **Durable execution** | `packages/workflow` (`WorkflowAgent`), `packages/workflow-harness` | Agent loop on the Vercel Workflow DevKit; model calls and tools are `'use step'` durable steps. |
| **Third-party harness wrapping** | `packages/harness` + `harness-claude-code`, `harness-codex`, `harness-opencode`, `harness-pi`, `harness-deepagents` | A versioned `HarnessV1` spec that wraps external coding agents (Claude Code, Codex, Pi, …) behind one session interface — directly analogous to Alchemy's "wrapped third-party harness Kernel". |
| **Telemetry consumer** | `packages/otel` | Consumes the core's tracing channel, emits `gen_ai.*` OTel spans. |
| **UI frameworks** | `react`, `vue`, `svelte`, `angular`, `rsc` | Thin consumers of the UI message stream protocol. |
| **Sandboxes** | `sandbox-vercel`, `sandbox-just-bash` | `Experimental_SandboxSession` implementations threaded through tool execution. |

**Where the loop lives:** `packages/ai/src/generate-text/generate-text.ts:786-1351` (the `do/while`), mirrored in streaming form in `stream-text.ts` (~2900 lines). `ToolLoopAgent` (`src/agent/tool-loop-agent.ts`) is a thin settings-holder that delegates to these functions — the agent class adds nothing to the loop itself.

No Temporal adapter exists in the repo (searched; only fixture-text false positives). The durable-execution story is exclusively the Vercel Workflow DevKit.

---

## 2. Per-topic findings

### 2.1 The loop

`generateText` runs a `do/while` over "steps" where one step = one model call + tool executions (`generate-text.ts:786-1351`). Per step:

1. `prepareStep?.(…)` — optional caller hook may override model, tools, toolChoice, instructions, messages, contexts, sandbox, providerOptions (`generate-text.ts:806-818`).
2. Convert to the standardized `LanguageModelV4Prompt`; `prepareTools`; `prepareToolChoice`.
3. `stepModel.doGenerate(...)` wrapped in a retry (`retry(async () => …)` at `generate-text.ts:933`, `prepareRetries` default `maxRetries: 2`, exponential backoff).
4. Parse tool calls (`parseToolCall`, with `experimental_repairToolCall` and `experimental_refineToolInput` hooks).
5. Resolve approval status per tool call (`resolveToolApproval`, `generate-text.ts:1062-1137`) — may block calls behind `user-approval` or auto-deny.
6. Execute non-blocked client tool calls **in parallel** — `Promise.all` in `executeTools` (`generate-text.ts:1491-1509`).
7. Build a `StepResult` (content, usage, finishReason `{unified, raw}`, performance metrics, warnings), append response messages, `messagesForNextStep = [...stepMessages, ...stepResponseMessages]` (`generate-text.ts:1326`).

**Continue condition** (`generate-text.ts:1341-1351`), verbatim:

```ts
} while (
  // Continue if:
  // 1. There are client tool calls that have all been executed or denied, OR
  // 2. There are pending deferred results from provider-executed tools
  ((clientToolCalls.length > 0 &&
    clientToolOutputs.length + deniedToolApprovalResponses.length ===
      clientToolCalls.length) ||
    pendingDeferredToolCalls.size > 0) &&
  // continue until a stop condition is met:
  !(await isStopConditionMet({ stopConditions, steps }))
);
```

**Stop conditions** (`stop-condition.ts`): `StopCondition = ({steps}) => boolean | Promise<boolean>`. Built-ins: `isStepCount(n)`, `hasToolCall(...names)`, `isLoopFinished()` (constant `false` — run until natural termination). Defaults: `isStepCount(1)` for bare `generateText` (`generate-text.ts:240`), `isStepCount(20)` for `ToolLoopAgent` (`tool-loop-agent.ts:132`). The doc comment (`stop-condition.ts:8-12`) enumerates the natural terminations:

> A tool calling loop continues until one of the following conditions is met:
> - The model returns a finish reason other than `tool-calls`
> - A tool without an execute function is called
> - A tool call needs approval

**Important semantics:** `stopWhen` is only evaluated *when the last step contains tool results* (v5 migration guide, `26-migration-guide-5-0.mdx:1212`). And structured output is parsed **only if the final `finishReason === 'stop'`** (`generate-text.ts:1424-1436`); accessing `result.output` otherwise throws `NoOutputGeneratedError` (`generate-text.ts:1626-1632`). So an untyped stop path yields a result whose "Out" is a runtime throw — see Insight 3.

Error semantics: model-call failures retry then throw; **tool execution errors do not throw** — they become `tool-error` content parts fed back to the model as the next step's input. Timeouts exist at two grains: total and per-step (`getTotalTimeoutMs`/`getStepTimeoutMs`, merged into one `AbortSignal` at `generate-text.ts:567-575`).

### 2.2 Memory & compaction

Core state is exactly one growing `ModelMessage[]`. There is **no compaction in the loop**. What exists:

- `prepareStep` may replace `messages` per step, and (since v7) the override **carries forward** to later steps (`prepare-step.ts:63-66`, v7 migration `23-migration-guide-7-0.mdx:366-390`). This is the sanctioned place to prune/summarize mid-loop.
- `pruneMessages` (`prune-messages.ts`) — a pure utility, not wired into the loop: strips reasoning (`all` / `before-last-message`), prunes tool calls/results/approvals by recency (`before-last-N-messages`) and by tool name, removes emptied messages. It has explicit **orphan protection**: kept-message tool-call ids and approval ids are collected first, and tool names for approval responses are resolved via *global* (cross-message) id→name maps, with a comment documenting the orphaned-approval bug that per-message resolution caused (`prune-messages.ts:103-109`).
- Everything else is deliberately userland: the Memory doc (`content/docs/03-agents/06-memory.mdx`) offers three approaches — provider-defined memory tools (Anthropic's `memory_20250818`), memory *providers* (Letta, Mem0, Supermemory, Hindsight, MongoDB — all wrap the model or supply tools), or a custom tool. Compaction of a wrapped third-party harness is delegated to the runtime via `HarnessV1Session.doCompact` ("the runtime owns the compaction — the harness neither implements nor schedules it", `harness-v1-session.ts:203-214`).

So the SDK's position matches Alchemy's inversion: memory is not a framework concept; the framework provides one seam (`prepareStep`) and one pure helper (`pruneMessages`).

### 2.3 Tool system

`Tool` is a 4-way union (`provider-utils/src/types/tool.ts:328-336`): `FunctionTool` (user schema, SDK-executed), `DynamicTool` (runtime-defined, e.g. MCP; types unknown at compile time), `ProviderDefinedTool` (provider schema, **user**-executed — e.g. Anthropic's shell tool), `ProviderExecutedTool` (provider schema, provider-executed — web search, code execution; may `supportsDeferredResults`).

Notable fields on `BaseTool`/`BaseFunctionTool` (`tool.ts:56-216`):
- `inputSchema` (required, `FlexibleSchema` — zod/valibot/raw JSON schema), `outputSchema` optional; `execute` optional — **a tool without `execute` is a natural loop terminator** (frontend/HITL tools).
- `contextSchema` + per-call `toolsContext`, plus `runtimeContext` — two typed context channels threaded through the whole lifecycle.
- `description` can be a **function of context/sandbox** (`tool.ts:189-194`) — dynamic per-call tool descriptions.
- `toModelOutput` (`tool.ts:149-168`) — maps the stored/displayed output to what the *model* sees. The load-bearing context-isolation primitive (see Subagents).
- `metadata` — propagated to `toolMetadata` on calls/results but **not sent to the model** (`tool.ts:76-84`); lets tool sources (MCP servers) identify themselves in traces.
- Streaming hooks `onInputStart`/`onInputDelta`/`onInputAvailable`; `inputExamples`; per-tool `strict` mode.
- `needsApproval` is **deprecated at the tool level** ("Tool approval is handled on a generateText/streamText level now", `tool.ts:105`) — except `WorkflowAgent` still uses it (see 2.8).

Execution: parallel per step (`Promise.all`, `generate-text.ts:1491`), per-tool timeout support in the `timeout` configuration, abort signal passed into `execute`. Invalid tool calls become `tool-error` outputs rather than failures (`generate-text.ts:1142-1157`). Repair (`experimental_repairToolCall`) lets a second model call fix malformed tool inputs. `execute` may be an **async generator**: each `yield` is a "preliminary" result streamed to the UI, with only the final value becoming the tool result.

### 2.4 Subagents — built and managed how?

**There is no subagent primitive.** The SDK's official pattern (`content/docs/03-agents/06-subagents.mdx`) is: *a tool whose `execute` calls another agent* —

```ts
const researchTool = tool({
  inputSchema: z.object({ task: z.string() }),
  execute: async ({ task }, { abortSignal }) => {
    const result = await researchSubagent.generate({ prompt: task, abortSignal });
    return result.text;
  },
});
```

What the SDK *does* provide around this pattern:
- **Abort propagation** — `abortSignal` is handed to `execute`, docs insist it be forwarded (`06-subagents.mdx:104-118`).
- **Streaming progress** — generator `execute` + `readUIMessageStream` yields an ever-growing `UIMessage` of the subagent's parts as preliminary results (`06-subagents.mdx:155-181`).
- **Context control** — `toModelOutput` extracts just the final summary for the parent model while the UI/history keeps the full nested transcript (`06-subagents.mdx:183-225`): "The subagent might use 100,000 tokens exploring and reasoning, but the main agent only consumes the summary."
- **History injection is opt-in** — `messages` is available inside `execute` if you want to pass parent history down (`06-subagents.mdx:341-360`), "use this sparingly".

Management (budgets, supervision, lifecycle) is entirely userland. One hard caveat: **tool approvals do not work inside subagents** (`06-subagents.mdx:333-339`) — the approval protocol assumes the top-level loop's message list, and a nested loop has nowhere to surface a paused approval. This is a concrete failure of composability worth noting (Insight 7).

### 2.5 Sessions / state / durability

Core: **stateless**. Messages in, steps out; the app persists `UIMessage`s (its own format) and reconstitutes `ModelMessage`s via `convertToModelMessages`. `useChat` supports resuming an interrupted SSE stream via transports.

The durable layer is `@ai-sdk/workflow` (`WorkflowAgent`, `packages/workflow/src/workflow-agent.ts`, 2914 lines) on the Vercel Workflow DevKit:

- Each **model call is a durable step**: `doStreamStep` is marked `'use step'` (`do-stream-step.ts:114`) and returns a *minimal serializable aggregate* rather than the full StepResult — the comment at `do-stream-step.ts:86-94` explains they deliberately strip redundant copies so "the durable event log doesn't carry StepResult's redundant copies".
- **Tools become durable steps** by marking their execute with `'use step'` — automatic retries (default 3), persistence, per-step dashboard visibility (`content/docs/03-agents/07-workflow-agent.mdx:269-300`).
- **Serialization boundary pain**: zod schemas contain functions and can't cross the step boundary, so tools are serialized to JSON-schema descriptors and revalidated with Ajv on the far side (`do-stream-step.ts:122-127`, `serializable-schema.ts`).
- **Durable approval**: `needsApproval` on a `WorkflowAgent` tool suspends the workflow; "the approval request survives process restarts — the user can approve hours later" (`07-workflow-agent.mdx:303-337`).

`@ai-sdk/workflow-harness` adds the **slice loop** for long harness turns (`run-harness-agent-slice.ts`):
- A slice runs a harness turn against a wall-clock budget of **750s, chosen to land just under Vercel Fluid Compute's ~800s instance recycle** (`run-harness-agent-slice.ts:18-26`).
- On budget expiry it calls `session.suspendTurn()` — the sandbox keeps running; the returned `continueFrom` cursor is the serializable checkpoint; the next slice reattaches losslessly (bridge attach/replay) or lossily (rerun) per adapter (`harness-v1-session.ts:216-256`).
- **Stream continuity across slices**: open text/reasoning/tool-input blocks are recorded in a serializable `streamContext`; the next slice re-emits the recorded `text-start`/`reasoning-start`/`tool-input-available` *prelude* chunks before continuing deltas, so the UI stream never sees a delta for a block it never saw start (`run-harness-agent-slice.ts:323-459`). This is a worked solution to "resume a stream mid-block after eviction".

### 2.6 Async vs sync: streaming end to end

Three protocol layers, all web-streams (pull-based backpressure end to end):

1. **Provider stream** — `LanguageModelV4StreamPart` (v3 shown at `provider/src/language-model/v3/language-model-v3-stream-part.ts`): id-keyed block lifecycle (`text-start`/`text-delta`/`text-end`, same for reasoning and tool-input), tool-call/tool-result/tool-approval-request parts, `stream-start {warnings}`, `response-metadata` (sent as soon as available, separate from `finish`), `finish {usage, finishReason}`, optional `raw` chunks, and **in-band `error` parts** ("error parts are streamed, allowing for multiple errors", `…stream-part.ts:102-106`).
2. **`fullStream`** — `TextStreamPart` in `stream-text.ts`; multiple steps are stitched with `createStitchableStream` (`stream-text.ts:1429-1432`), adding `start-step`/`finish-step` boundaries.
3. **UI message stream** — `UIMessageChunk` (`ui-message-stream/ui-message-chunks.ts`, ~30 chunk types incl. `tool-approval-request`, `tool-output-denied`, `data-*` custom parts, `message-metadata`, `abort`), serialized as SSE.

Smoothing is a stream transform, not core behavior: `smoothStream({ delayInMs, chunking: 'word' | 'line' | RegExp | Intl.Segmenter | ChunkDetector })` (`smooth-stream.ts:26-55`).

Abort: one merged `AbortSignal` (user signal + total timeout + per-step timeout, `merge-abort-signals`), passed to provider fetch and every tool `execute`; the UI protocol has an explicit `abort` chunk. Orphaned tool calls after an abort are handled at the persistence boundary: `convertToModelMessages(messages, { ignoreIncompleteToolCalls: true })` (`06-subagents.mdx:120-130`).

### 2.7 Pluggability

- **Versioned spec with up-conversion.** `resolveLanguageModel` accepts `'v4' | 'v3' | 'v2'` models and adapts older ones via `asLanguageModelV4` (`model/resolve-model.ts:29-40`). Middleware similarly accepts v2/v3/v4 and returns v4 (`middleware/wrap-language-model.ts:31-42`). This is how 40 providers survive spec churn: **the core chases the newest spec; adapters carry stragglers.**
- **Middleware** — `wrapLanguageModel({ model, middleware })` with `transformParams` / `wrapGenerate` / `wrapStream` / `overrideProvider|ModelId|SupportedUrls` (`wrap-language-model.ts:44-113`), reduce-composed so the first middleware transforms input first. Shipped middlewares: `extractReasoningMiddleware` (parse `<think>` tags into reasoning parts), `simulateStreamingMiddleware`, `defaultSettingsMiddleware`, `addToolInputExamplesMiddleware`.
- **Registry** — `createProviderRegistry` maps `"providerId:modelId"` strings (configurable separator, `registry/provider-registry.ts:132-143`); `customProvider` re-aliases/patches models. The **global provider defaults to the Vercel AI Gateway**, so `model: "anthropic/claude-sonnet-4-6"` as a plain string works with zero setup (`resolve-model.ts:30-32`).
- **Capability signaling by warnings, not flags.** There is no static capability object on `LanguageModelV3/V4`; unsupported settings produce `stream-start.warnings` / result `warnings` that the core logs (`logWarnings`). The only static capability surface is `supportedUrls` (media-type → URL regexes deciding download-vs-passthrough, `language-model-v3.ts:24-38`). The `HarnessV1` spec makes the philosophy explicit: "There is intentionally no static 'capabilities' object — … Adapters that cannot satisfy a request throw `HarnessCapabilityUnsupportedError` from the method that needs the capability" (`harness-v1.ts:15-19`).

### 2.8 Human-in-the-loop

The approval flow is fully reified **as message content parts**, which makes it serializable, resumable, and transport-agnostic:

1. Model requests a tool call → `resolveToolApproval` consults the call-level `toolApproval` configuration (`tool-approval-configuration.ts`): per-tool status/function or one generic function, returning `'not-applicable' | 'approved' | 'denied' | 'user-approval'` (optionally with `reason`).
2. `user-approval` → the step's content gains a `tool-approval-request { approvalId, toolCall, signature? }` part; the tool call is blocked; the loop **stops naturally** (approval is one of the three natural terminations, `stop-condition.ts:11`).
3. The request flows to the UI as a `tool-approval-request` chunk; the client answers via `chat.addToolApprovalResponse` (`ui/chat.ts:477`), optionally auto-resubmitting via `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`.
4. The **next** `generateText` call scans the last tool message for approval responses (`collectToolApprovals`, `collect-tool-approvals.ts:22-38`), re-validates them (`validateApprovedToolApprovals`) — including **HMAC signature verification** when `experimental_toolApprovalSecret` is set ("the server signs each approval request at issuance and verifies the signature when the approval is replayed, preventing client-forged approvals", `generate-text.ts:359-364`) — executes approved calls *before the first model step*, and converts denials into `execution-denied` tool results (`generate-text.ts:678-760`).

Provider-executed tools can also emit approval requests (spec-level `LanguageModelV3ToolApprovalRequest`; the denial path threads OpenAI's `approvalId` back through `providerOptions`, `generate-text.ts:744-752`).

So HITL = *stop the loop, park the question in the conversation, re-enter later*. State lives entirely in messages; the server holds nothing. `WorkflowAgent` upgrades this to a durable suspension without changing the shape. Two costs: approvals don't compose into subagents (2.4), and the id-security surface is real enough that they added prototype-pollution defenses (`Object.create(null)` maps keyed by client-supplied ids, `collect-tool-approvals.ts:40-50`) and HMAC signing.

### 2.9 Provider abstraction (the core topic)

The spec boundary (v3/v4 nearly identical in shape; v4 shown where they differ):

```ts
// provider/src/language-model/v3/language-model-v3.ts:8-61
type LanguageModelV3 = {
  readonly specificationVersion: 'v3';
  readonly provider: string;
  readonly modelId: string;
  supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  doGenerate(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3GenerateResult>;
  doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult>;
};
```

The `do` prefix exists "to prevent accidental direct usage of the method by the user" (`language-model-v3.ts:43-44`) — the raw spec is not the app-facing API.

**CallOptions** (`language-model-v3-call-options.ts`): a *standardized* `prompt` ("This is **not** the user-facing prompt. … That approach allows us to evolve the user-facing prompts without breaking the language model interface", lines 10-16), sampling params, `responseFormat` (text | json+schema), `tools` (function tools with JSON-schema inputs + provider tools), `toolChoice`, `includeRawChunks`, `abortSignal`, `headers`, and `providerOptions` — the namespaced escape hatch, which also appears **on every message part and every stream part** (`providerMetadata` on the way out). v4 adds a first-class `reasoning` effort option (`language-model-v4-call-options.ts:120-123`).

**Content part union** (result + stream): `text`, `reasoning`, `file`, `source`, `tool-call`, `tool-result`, `tool-approval-request` (v3+), `custom` and `reasoning-file` (v4+). Tool-call deltas are id-keyed `tool-input-start/delta/end` blocks with `providerExecuted` and `dynamic` flags.

**Spec evolution and why:**
- **v1→v2 (SDK v5)**: `promptTokens/completionTokens` → `inputTokens/outputTokens (+required totalTokens)`; flat `{type:'text-delta', textDelta}` parts → **id-keyed start/delta/end blocks** — required once models emitted parallel and interleaved text/reasoning/tool blocks (`26-migration-guide-5-0.mdx:2719-2800`); middleware and types moved into `@ai-sdk/provider` and got version-suffixed names.
- **v2→v3 (SDK v6)**: finish reason `'unknown'` merged into `'other'` (v2 had both, consumers could do nothing useful with the distinction — `24-migration-guide-6-0.mdx:486`); `tool-approval-request` entered the spec; warning types unified; per-tool `strict`.
- **v3→v4 (SDK v7)**: `finishReason` became `{ unified, raw }` — the unified enum plus the provider's raw string (`language-model-v4-finish-reason.ts`); usage became structured `inputTokens {total, noCache, cacheRead, cacheWrite}` / `outputTokens {total, text, reasoning}` **plus `raw` passthrough** (`language-model-v4-usage.ts`) — note every count is `number | undefined`, encoding "providers often don't report this"; `reasoning` effort in call options; `custom` content parts; `reasoning-file`.

The direction across three revisions is consistent: **(a)** id-keyed block streaming, **(b)** *unified + raw* dual representation wherever the unified value loses information (finish reasons, usage), **(c)** provider escape hatches at every granularity.

**Error taxonomy** (`packages/provider/src/errors/`): `APICallError` (with `isRetryable`, status, response body), `NoSuchToolError`, `InvalidToolInputError`, `UnsupportedFunctionalityError`, `NoSuchModelError`, etc. Retryability is a property on the error, decided by the provider; the core's retry loop consumes it. Coarser than distilled's per-operation typed unions — closer to "HTTP-shaped" errors with flags.

### 2.10 Integration surfaces

- `useChat` (react/vue/svelte/angular) consumes the UI message stream; transports are pluggable (`DefaultChatTransport` HTTP+SSE, `DirectChatTransport` in-process, `WorkflowChatTransport` with stream repair for resumable durable runs). `UIMessage` is the persistence format, distinct from `ModelMessage`, with typed `data-*` parts and metadata; `validateUIMessages` guards ingestion.
- **Telemetry**: v7 replaced the inline OTel integration with a **tracing-channel architecture** — the core publishes typed events (`generateText`, `step`, `languageModelCall`, `executeTool`, …) on a `diagnostics_channel`-style channel (`telemetry/tracing-channel.ts`), a `TelemetryDispatcher` fans out to callbacks, and `@ai-sdk/otel` is just one consumer mapping events to `gen_ai.*` spans (`otel/src/legacy-open-telemetry.ts`). A "restricted dispatcher" redacts `runtimeContext`/`toolsContext` from telemetry unless opted in (`restricted-telemetry-dispatcher.ts`). The core no longer imports OTel.
- Edge/serverless: core is dependency-light web-standard code; v7 went ESM-only and raised the Node floor. The 750s slice budget (2.5) is the only place a platform constraint is hard-coded, and it's a default, not a constant.

---

## 3. Judgments

### What they got right

1. **Versioned spec + up-conversion adapters.** Four spec versions in ~3 years, ~40 providers, and no flag-day: old models are adapted (`asLanguageModelV4`), new core chases the latest. The boundary *will* churn; version it and shim.
2. **The standardized-prompt decoupling.** The spec's `prompt` is explicitly not the user-facing prompt (call-options comment) — user-facing prompt sugar evolved wildly (v5/v6/v7 all changed it) while the provider boundary barely moved.
3. **Unified + raw everywhere.** v4's `{unified, raw}` finish reason and `usage.raw` concede that any normalization loses information; keep both. (They learned this the hard way — see mistakes.)
4. **Escape hatches at every granularity.** `providerOptions`/`providerMetadata` on the call, on each message part, on each stream part. This is what let provider-specific features (Anthropic cache control, OpenAI approval ids) ship without spec revisions.
5. **Approval as message parts.** Serializable, replayable, signable, transport-agnostic; the loop-stops-and-re-enters shape means zero server state for HITL.
6. **`toModelOutput`** — separating what the model sees from what is stored/displayed is the single most load-bearing context-management primitive in the SDK, and it's one function on a tool.
7. **Keeping memory, subagents, and orchestration out of core** — the ecosystem filled all three (memory providers, the documented subagent pattern, workflow packages) without core changes.
8. **Warnings over capability flags**, and `HarnessV1`'s sharpened version: capability = presence of a method; unsupported = a typed error thrown from the method that needed it. Static capability matrices rot.
9. **Telemetry as an event channel with an external OTel consumer** (v7) — after shipping the coupled version first (see mistakes).
10. **`toolOrder` for prompt-cache stability** — tools are sent in a stable (listed-then-alphabetical) order specifically to improve provider-side caching (`generate-text.ts:339-345`). Small, telling detail.

### What the breaking changes reveal (v4→v5→v6→v7)

1. **`maxSteps` → `stopWhen`** (v5): a scalar limit was the wrong shape; termination is a *predicate over the step history*. But the replacement has a trap they had to document in bold: `stopWhen` only fires when the last step has tool results, and `isStepCount` is `steps.length === n` (equality, not ≥, `stop-condition.ts:27-29`). Stop semantics entangled with loop-phase is a subtle contract.
2. **`result.usage` silently changed meaning** (v5): from "total across steps" to "final step only", with `totalUsage` added. A semantic break hiding under an unchanged name — the worst kind.
3. **`'unknown'` finish reason removed** (v6): a union member consumers could do nothing with. Then v7 *re-added* the lost information properly as `raw`. Two majors to land on "unified + raw".
4. **Tool-level `needsApproval` deprecated for call-level `toolApproval`** (v6/v7): approval is a *policy of the caller*, not a property of the tool — the same conclusion as Alchemy's autonomy-dial-as-Layer. But `WorkflowAgent` still uses tool-level `needsApproval` (`07-workflow-agent.mdx:303-308`), so the SDK currently ships **both** conventions. Policy attached to the wrong term is expensive to move.
5. **`experimental_` churn**: `generate-text.ts` carries ~10 deprecated `experimental_on*` aliases beside their stable names (lines 263-278). The experimental-prefix strategy produced a large permanent alias surface. Naming stability is part of the interface design budget.
6. **Flat stream parts → id-keyed blocks** (v5): the v1 stream shape structurally could not express parallel/interleaved blocks. Getting the *stream algebra* right up front matters more than any single part type.
7. **`generateObject`/`streamObject` deprecated** (v6) into an `output` parameter on the one loop — two parallel top-level APIs collapsed into one. Fewer entry points, more composition.
8. **`prepareStep` carry-forward semantics changed** (v7): whether a per-step override of instructions/messages persists into later steps flipped between majors (`23-migration-guide-7-0.mdx:366-390`). Implicit statefulness in a "pure-looking" per-step hook is a bug generator — an argument for Alchemy's explicit `StepState`.
9. **Continuation-steps removal** (v5): automatic continuation when output was length-capped was removed as too magical. Implicit loop-extension behaviors don't survive.
10. **Inline OTel → tracing channel** (v7): baking a specific observability stack into the core loop was reverted after three majors.

---

## 4. Insights for Alchemy — numbered

1. **`CallModel` should mirror the `LanguageModelV4` call/result shape, not a simplified one.** Concretely: standardized prompt distinct from rendered charter text; `responseFormat` with JSON schema; tools as JSON-schema descriptors; `providerOptions` passthrough; result carrying `{unified, raw}` finishReason, structured usage *with cache-token detail*, warnings, and provider metadata. The cache detail is not optional for us: **`AI.budget({ usd })` cannot be computed without `cacheRead`/`cacheWrite`/`noCache` splits** (cached tokens are billed differently), and v4's usage type is the battle-tested shape (`language-model-v4-usage.ts`). Also adopt its honesty: every count is `number | undefined` — the Kernel's budget accounting needs a declared policy for *unknown* usage (fail-open, fail-closed, or estimate), or `BudgetExceeded` is unenforceable on some providers. Going through `@effect/ai` is fine, but verify its model-call result preserves raw finish reason, cache-token splits, and per-part provider metadata; if it doesn't, our `ModelCompleted` Trace event must not inherit the loss.

2. **Version the Kernel contract the way they version the model spec.** `specificationVersion` tag + up-conversion adapters is what let 40 providers survive v2→v3→v4. Alchemy has the same problem twice: the `Kernel` tag itself (design §2.1) and the Trace event schema (§2.3). Freeze a `KernelEvent` v1 with an explicit version discriminant and plan for adapters; the AI SDK's cadence (a spec rev roughly yearly) is the realistic churn rate. `HarnessV1`'s comment is the design to copy: versioned spec, `do*`-prefixed methods, capability-by-method-presence.

3. **Their stop conditions are the untyped version of our halt — and the failure mode is visible in their API.** `stopWhen: hasToolCall('finalizeTask')` stops the loop, but the result type doesn't know it: `result.output` **throws `NoOutputGeneratedError`** unless `finishReason === 'stop'` (`generate-text.ts:1424-1436, 1626-1632`). That runtime throw is exactly what `Loop<Out,…>` with `Out` derived from `AI.until(schema)` makes a compile error (design §1.2.2, §1.5). Keep the derivation; it's the single clearest advantage over the industry baseline. One thing worth stealing anyway: `stopWhen` accepts an **array** (disjunction) of conditions — congruent with §8.4's "exit is a prioritized disjunction"; our kernel's internal halt evaluation should be an ordered disjunction (halt-met / budget / stall / interrupt), even though the *type* only names the success arm and `Err`.

4. **`prepareStep` is their whole answer to mid-loop steering, and its history is a warning for our step machine.** One caller-supplied hook can swap model, tools, messages, instructions, sandbox per step (`prepare-step.ts:100-179`) — it subsumes model routing, context policy, and tool gating. Two lessons: (a) it's *caller-facing*, whereas Alchemy makes context policy an implementation-private seam (`ContextPolicy`, §2.6) — the AI SDK shows users genuinely need per-step model routing and tool gating too, so expect pressure to expose more than `ContextPolicy` through kernel-layer options; better to let those remain seams with well-known tags than grow a mega-hook. (b) The v6→v7 carry-forward flip (Judgment 8) happened because the hook's statefulness was implicit. Our `step(state, feedback) → [state', commands]` makes carried state explicit in `StepState` — enforce that *everything* that carries forward lives there, and nothing else does.

5. **The tool-pairing invariant in the wild is messier than "no orphans" — it includes *sanctioned* orphans.** The AI SDK enforces pairing in three places (prune-time orphan protection with cross-message id maps, `prune-messages.ts:103-139`; `asContent` throwing `Tool call ${id} not found` at `generate-text.ts:1708`; `ignoreIncompleteToolCalls` at the persistence boundary) — and then deliberately *breaks* it for provider-executed tools with `supportsDeferredResults`, where a result legitimately arrives in a later turn with no matching call in the current response (`generate-text.ts:781-784, 1232-1259`; `tool.ts:305-318`). Alchemy's Kernel obligation (§2.4 "no orphaned tool results after trimming/recovery") should be stated as: *every tool result must pair with a call somewhere in the retained Trace, or be explicitly declared deferred* — a strict invariant plus a typed exemption, not just the strict invariant. Property tests should include the deferred case.

6. **Approval-as-data validates the `Ask` command — and adds two requirements we haven't written down.** Their approval round-trip is: request reified as a content part with a fresh `approvalId`, loop stops, answer arrives as data in the next request, answer is **re-validated and HMAC-verified** before execution (`generate-text.ts:658-676`, `tool-approval-signature.ts`). For Alchemy: (a) `Ask`/`AskAnswer` must be Trace events with stable ids so replay and fold see them (§2.3 already implies this); (b) because our answers arrive over *world* surfaces (Discord replies, GitHub reviews), **answer authenticity is a first-class concern** — sign the ask, verify the answer, and treat `collectToolApprovals`' `Object.create(null)` id-map defense as the minimum bar for attacker-supplied ids. Also note their composability failure: approvals don't work inside subagents (`06-subagents.mdx:333-339`) because the protocol is welded to the top-level message list. Our `Ask` being a *command interpreted by the harness* (not a message-list convention) is what should make it compose through `ForkLoop` — write a conformance test for exactly that (an inner loop's `Ask` escalating through a parent ring).

7. **Subagents-by-composition is confirmed; `toModelOutput` names the seam we should make fold-shaped.** The SDK provides no subagent primitive and its docs get all the way to Claude-Code-style isolation with `tool() + agent.generate + toModelOutput` — strong support for §2.4 "sub-agents are not a Kernel feature". The specific trick to keep: the *full* nested transcript is retained (UI/history/Trace) while the parent model sees only the distilled summary. In Alchemy terms, an interpolated `${Loop}`'s dispatch should append the run's `Out` (distilled) to the parent's context while the child's full Trace remains linked-but-external — which is design §2.5's "iteration return value" channel; the AI SDK confirms the same split works and that the summary must be *demanded* of the sub-agent in its instructions or you get "Done" (`06-subagents.mdx:227-245`) — a renderer/lint concern for charters that nest loops.

8. **The slice loop is a working blueprint for the Ring DO's `doFiber` durability, including the part we hadn't designed: stream recovery.** Their pattern (`run-harness-agent-slice.ts`): wall-clock budget deliberately below the platform recycle limit (750s vs ~800s); suspend freezes at a precise event cursor while the sandbox keeps running; the serializable state object is the step's return value (checkpoint = return value, no separate API); and — the novel bit — a serializable `streamContext` of *open block start-chunks* so the next slice can re-emit `text-start`/`tool-input-available` preludes before continuing deltas (`run-harness-agent-slice.ts:323-459`). For the Cloudflare harness: a DO evicted mid-turn that recovers via `Resume` (§3.2) has the same problem — subscribers of the ring's event stream must not see `ModelDelta` for a block whose start was lost. Either journal block-start events in the Trace as part of `stash`, or make the Trace the stream (then replay is free). Their lossless-vs-lossy contract (`doContinueTurn`'s attach/replay vs rerun, `harness-v1-session.ts:216-235`) is also the right vocabulary for our `Resume` policy's `Continue | Retry | Terminal`.

9. **Serialization boundaries bite schemas; we're structurally immune — keep it that way.** `WorkflowAgent` cannot pass zod tools across a `'use step'` boundary (functions don't serialize) and resorts to JSON-schema + Ajv revalidation (`do-stream-step.ts:122-127`). Alchemy terms are pure data and Effect Schema has a serializable AST, so `StepState`/fold checkpoints can carry schema *references or ASTs* natively. The rule to adopt from their pain: **nothing in `StepState` may close over a function** — which design §2.4 already states ("no handles, no sockets, no clocks"); add "no schema closures" to the list explicitly.

10. **`HarnessV1` is prior art for the "wrap a third-party harness as a Kernel" plan — copy its lifecycle verbs, reject its statelessness.** They wrapped Claude Code/Codex/OpenCode/Pi/deepagents behind one versioned spec whose session verbs (`doPromptTurn`, `doSuspendTurn`, `doContinueTurn`, `doDetach`, `doStop`, `doDestroy`, `doCompact`) are a good checklist for what a wrapped-kernel Layer must be able to ask of an external harness (design §0.3 "wrapped third-party" interpretations). Two of their choices matter for us: capability signaling by *throwing a typed error from the optional method* rather than static flags (harness heterogeneity is too fine-grained for a matrix — `harness-v1.ts:15-19`); and `instructions` applied exactly once on a fresh session, never re-applied on resume (`harness-v1-session.ts:114-121`) — the same idempotency discipline our promptHash-stable renderer needs at the session boundary.

11. **Telemetry: the v7 tracing-channel refactor independently confirms §2.3.** They started with OTel spans wired into the loop, and after three majors moved to "core emits typed events on a channel; `@ai-sdk/otel` is one consumer" (`telemetry/tracing-channel.ts`, `otel/src/legacy-open-telemetry.ts`). That is exactly Alchemy's "Trace is the single representation; OTel is an exporter". Two details to borrow: the **restricted dispatcher** that redacts user context from telemetry by default (`restricted-telemetry-dispatcher.ts`) — our Trace will carry prompts and tool payloads, and redaction classes should exist in the event schema from v1, not be retrofitted; and their event-type vocabulary (`generateText`/`step`/`languageModelCall`/`executeTool`) maps cleanly onto our `TurnStarted`/`ModelRequested`/`ToolRequested` set — plus per-step performance metrics (tokens/sec, timeToFirstOutput, `toolExecutionMs`, `generate-text.ts:1211-1230`) which our `KernelEvent`s don't currently carry and autoresearch will want.

12. **Adopt id-keyed block streaming in `KernelEvent` from day one.** Their v1→v2 stream rewrite (flat deltas → `{start,delta,end} × id`) was forced by parallel/interleaved model output and was the most disruptive provider-facing change they ever shipped (`26-migration-guide-5-0.mdx:2719-2800`). Our `ModelDelta` event should carry `{blockId, blockKind: text|reasoning|toolInput, delta}` and be bracketed by block start/end events — this is also precisely what makes Insight 8's stream recovery implementable.

13. **Type tool errors as results, not failures.** In the loop, a tool `execute` failure becomes a `tool-error` content part fed back to the model; only infrastructure failures throw. For the step machine: `Feedback.ToolResult` should be `Success(output) | ToolError(message)` and the *model* decides what to do with errors; the Effect error channel of a tool's Layer is reserved for harness-level failures the kernel converts to events/halts. This matches how their invalid-call handling works too (`generate-text.ts:1142-1157`) and keeps "the model can recover" and "the ring must escalate" as different types.

14. **Purity audit for `step`: their loop shows exactly which impurities creep in.** Inside their step they call `generateId()` for approval ids and response ids, `new Date()` as a response-timestamp fallback, and `now()` for perf timing (`generate-text.ts:951-957, 1078`). Every one of these, transplanted naively into our `step`, is a replay-divergence bug (§2.4's rule). The concrete checklist for our command interpreter: id generation is a *harness* concern (ids arrive in `Feedback` or are derived deterministically from `(session, stepIndex, ordinal)`), timestamps live only on Trace events written by the interpreter, and performance metrics are interpreter-side annotations — never inputs to `step`.

15. **Contradiction / pressure flags against `alchemy-ai-design.md`:**
    - **Sandbox wants a slot at the loop boundary.** The design (§3.2) makes `Sandbox` a harness-private seam invisible to the Kernel. The AI SDK started there too and ended up threading `experimental_sandbox` through `generateText` → `prepareStep` (swappable per step!) → every tool `execute` → even dynamic tool descriptions (`tool.ts:189-194`, `prepare-step.ts:164-169`). The ecosystem pressure to address the execution environment *from the loop's option surface* is real. This doesn't refute the seam design — per-term Layers (`BashDevBox` vs `BashReadOnly`) already give Alchemy per-agent physics the AI SDK can't express — but expect demand for *per-iteration* sandbox selection (fresh sandbox per Ralph iteration), which in our model must be expressible as a seam policy (e.g. `Sandbox` Layer scoped per-iteration `Scope`) and should be named in §3.2 explicitly.
    - **§2.1's `Kernel.events` as one merged firehose vs their per-call scoping.** Their telemetry attaches every event to a `callId` and step number, and the *restricted* dispatcher exists because a global firehose leaks context. Our single `Stream<KernelEvent>` with `{ring, term, session}` provenance (§2.3) is fine, but `AI.observe(Loop)` grants *whole-Trace* read access with no redaction vocabulary; the AI SDK's default-redact posture suggests observation grants should name an event-class filter (Autoresearch probably shouldn't read raw `AskHuman` payloads from Helpdesk threads containing user data).
    - **No budget prior art.** Nothing in the AI SDK meters cost or tokens as a control (only timeouts and step counts). Alchemy's `AI.budget` is genuinely ahead of this baseline — but see Insight 1: v4's all-optional usage numbers mean the *enforcement* policy under missing data is a design decision the AI SDK never had to make and we do.
    - **`hasToolCall` as halt vs our prose-`until`.** Their most-used real stop condition is "the model called the `finalizeTask` tool" — i.e. *halt is a tool call*. Our `AI.until(schema)` says halt is a judged condition resolving to a typed value. These reconcile nicely (the kernel's default judge policy can implement `until(schema)` as a synthetic `resolve` tool whose input schema is the halt schema — the model calls it, the check grades it), and that implementation trick — halt-as-provided-tool — is probably the cheapest correct Phase-2 implementation of `until`; worth writing into §2.5.

---

## 5. Honesty notes / limits

- The repo was studied at one commit (`5f0d553`, ai 7.0.18); statements about "current" behavior are pinned to it.
- `stream-text.ts` (~2900 lines) and `workflow-agent.ts` (2914 lines) were read *selectively* (targeted greps + sections), not exhaustively; streaming/backpressure claims rest on the stream-part types, `createStitchableStream` usage, `smooth-stream.ts`, and the slice-loop code, which I did read fully.
- I did not run any code and did not verify runtime behavior (e.g. actual retry timing, actual parallelism limits of `Promise.all` tool execution — there is no concurrency cap visible in `executeTools`).
- Resumable-stream internals of `WorkflowChatTransport` (stream repair) were noted from file names/tests but not read in depth.
- I found no Temporal (or other non-Vercel) durable-execution adapter in the repo; the uploaded docs dump (`ai-6.md`) is a scraped GitHub README and contributed nothing beyond the repo itself.
- The v5 migration guide refers to "AI SDK 4.0" types with confusingly renamed imports (e.g. `LanguageModelV3` shown under a v4→v5 heading at `26-migration-guide-5-0.mdx:2669-2680`) — the in-repo guide appears to have been mechanically re-versioned at some point; where guide text and `packages/provider` source disagreed, I trusted the source.
