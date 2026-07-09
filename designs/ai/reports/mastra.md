# Mastra (mastra-ai/mastra) — architecture study for Alchemy AI

Studied at commit `6b51b0c` (shallow clone, `main`, ~July 2026), `.vendor/mastra`. All paths below are relative to that directory. This is a much newer Mastra than the one alchemy-ai-design.md §0.1 describes — the repo has visibly gone through several redesign cycles (Harness→AgentController rename, streamVNext→stream, three parallel workflow engines, a `loop/` module that reimplements the agent loop *as* a workflow), and those cycles are themselves the most useful evidence.

---

## Architecture overview

Mastra is a **class-and-config framework** organized around one god object (`Mastra`, `packages/core/src/mastra/index.ts:604`) that acts as a registry/service-locator for agents, workflows, storage, pubsub, scorers, MCP servers, etc. There is no DI container: `packages/core/src/di/index.ts` just re-exports `RequestContext`, a per-request key-value bag threaded through every call. Wiring is done by string id lookup against the registry (`mastra.getAgent('weatherAgent')`).

The load-bearing architectural move (recent, and central to this report): **the agent loop is implemented as a Mastra workflow running on Mastra's own workflow engine.** `Agent.stream()` → `loop()` (`packages/core/src/loop/loop.ts:11`) → `workflowLoopStream` (`loop/workflows/stream.ts:18`) → an `agentic-loop` workflow (`loop/workflows/agentic-loop/index.ts:64`) that `.dowhile(...)`s an inner `executionWorkflow` (`loop/workflows/agentic-execution/index.ts:85`) whose step pipeline is:

```
llmExecutionStep → map(tool-calls) → foreach(toolCallStep) → llmMappingStep
  → backgroundTaskCheckStep → signalDrainStep → isTaskCompleteStep → goalStep
```

Because the loop is a workflow, suspend/resume (tool approval, human input), snapshot persistence, and the evented/distributed engine come for free — the same machinery workflows already had.

Package/module map (the parts that matter):

| Area | Location |
|---|---|
| Agent class (8,952 lines) | `packages/core/src/agent/agent.ts` |
| Agent loop (as workflow) | `packages/core/src/loop/` |
| Agent networks (routing loop) | `packages/core/src/loop/network/index.ts` (2,708 lines) |
| Workflow engine (3 engines: default, evented, + Inngest pkg) | `packages/core/src/workflows/`, `workflows/evented/`, `workflows/scheduler/` |
| Processor pipeline (the plugin system) | `packages/core/src/processors/` |
| Memory-as-processors (history, semantic recall, working memory) | `packages/core/src/processors/memory/` |
| Observational Memory (15,300 lines) | `packages/memory/src/processors/observational-memory/` |
| Tools (+ approval/suspension) | `packages/core/src/tools/` |
| Model router / gateways | `packages/core/src/llm/model/` |
| Storage (25 domain interfaces) | `packages/core/src/storage/` (+ `stores/*` implementations) |
| PubSub abstraction | `packages/core/src/events/pubsub.ts` (+ `pubsub/redis-streams`, `pubsub/google-cloud-pubsub`) |
| Schedules (cron→agent/workflow) | `packages/core/src/schedules/`, `workflows/scheduler/` |
| Signals (mid-run input injection) | `packages/core/src/agent/signals.ts`, `signals/github/` |
| Background tasks | `packages/core/src/background-tasks/` |
| AgentController / Session (ex-"Harness") | `packages/core/src/agent-controller/` (`harness/index.ts` is a deprecated alias) |
| Channels (Slack etc.) | `packages/core/src/channels/`, `channels/slack/` |
| Deployers (CF/Vercel/Netlify) | `deployers/cloudflare/` |
| Scorers/evals | `packages/core/src/evals/` |
| Design explorations (candid postmortems) | `explorations/*.md` |

---

## Per-topic findings

### 1. The loop

**Core loop = a `dowhile` workflow.** `createAgenticLoopWorkflow` (`loop/workflows/agentic-loop/index.ts:92`) wraps `executionWorkflow` in `.dowhile(agenticExecutionWorkflow, async ({ inputData }) => ...)`; the predicate at the bottom returns `typedInputData.stepResult?.isContinued ?? false` (`:295`).

**What drives iteration:** the default continue-signal is tool-call presence. In `llm-mapping-step.ts:441-457`, after tool results are folded back in: `isContinued = true; reason = 'tool-calls'` if there were calls; otherwise `isContinued = false` (unless a processor requested `reason === 'retry'`). On top of that base signal, *five* other mechanisms can override the decision, applied in this order per iteration:

1. `stopWhen` conditions (AI-SDK style, evaluated against accumulated `steps`, `agentic-loop/index.ts:165-178`).
2. `onIterationComplete` hook — user callback that can inject feedback text as an assistant message and force continue/stop (`agentic-loop/index.ts:181-262`).
3. Delegation bail — a sub-agent hook can set a run-scoped `_delegationBailed` flag (`agentic-loop/index.ts:265-268`).
4. `isTaskComplete` scorers — LLM/programmatic scorers run as a dedicated step; failure sets `isContinued = true` and injects judge feedback into the transcript (`agentic-execution/is-task-complete-step.ts:107-163`).
5. The **goal step** — a durable objective judged every turn (below).

**A "turn" is represented as** `LLMIterationData` (`loop/workflows/schema.ts`): `{ messageId, messages: {all,user,nonUser}, output: {text,toolCalls,toolResults,usage,...}, stepResult: {reason, isContinued, ...}, metadata }` — a serializable object passed between workflow steps and mutated in place (`stepResult.isContinued` is written by four different steps).

**The goal step is their AI.check.** `goal-step.ts:100-504` mirrors `is-task-complete-step` but is driven by a *durable objective record* persisted in a `threadState` `'goal'` slot: `{ objective, runsUsed, maxRuns, status: active|paused|done, pausedReason }`. Per iteration it: skips housekeeping iterations (working-memory-only tool calls, `:119-122`); resolves a judge model (a *separate* model from the actor); builds a `createGoalScorer` judge that may hold **its own readonly verification tools** and its own memory thread (`:294-311`, thread metadata `{forkedSubagent: true, goalJudge: true, parentThreadId}`); streams judge activity to the UI; and decides with explicit precedence (`:415-426`):

```
judge failed  → status 'paused' + pausedReason      (never silently re-loop on a broken judge)
complete      → status 'done'
budget spent  → status 'paused' ("Ran out of evaluation budget (N runs)... raise maxRuns to resume")
waiting       → keep 'active' but stop auto-loop (tri-state score GOAL_SCORE_WAITING)
else          → force isContinued = true, feed judge reason into the next iteration
```

There is also a defensive guard for an active record already at/over budget (e.g. maxRuns lowered below runsUsed) that stops without burning another judge call (`:146-169`).

**Exit conditions summarized:** no-tool-calls (default) ∨ stopWhen ∨ maxSteps ∨ scorer-complete ∨ goal-done/paused ∨ tripwire (processor abort) ∨ suspension (approval/suspend) ∨ error.

### 2. Memory & compaction

Memory is entirely **processors** now: `packages/core/src/processors/memory/{message-history,semantic-recall,working-memory}.ts`. `@mastra/memory`'s `Memory` class composes them plus OM.

**Observational Memory (OM)** — `packages/memory/src/processors/observational-memory/` (15.3k lines):

- **Roles.** Actor (main agent), Observer, Reflector. The Observer's prompt opens: *"You are the memory consciousness of an AI assistant. Your observations will be the ONLY information the assistant has about past interactions"* (`observer-agent.ts:395,454`). Output is XML-tagged: `<observations>` with `Date:` headers and priority-marked timestamped bullets (`* 🔴 (14:30) User prefers direct answers`), plus `<current-task>` and `<suggested-response>` blocks (`observer-agent.ts:414-443`). The Reflector condenses observations when *they* grow too large, with degenerate-output (repetition-loop) detection and retry (`types.ts:371`, `reflector-runner.ts`).
- **Thresholds.** Defaults `observation.messageTokens: 30_000`, `reflection.observationTokens: 40_000`, default model `google/gemini-2.5-flash` for both (`constants.ts:4-26`, `types.ts:84,274`). Thresholds may be dynamic ranges `{min,max}` scaled by how full the observation space is (`types.ts:23-28`, `thresholds.ts`).
- **When observations are written.** The processor hooks `processInputStep` (every loop step, not just turn start): a per-step `step.prepare()` checks thresholds and either activates buffered observations or triggers observation (`processor.ts:265-290`). The killer mechanism is **async buffering**: `bufferTokens` (default 0.2 = every 20% of threshold) runs the Observer *in the background* while the actor keeps working, storing sealed chunks; when the main threshold is crossed, **activation is an instant swap** — no blocking LLM call (`types.ts:113-155`). `blockAfter` forces a synchronous observation only as a last resort. Buffered chunks are also force-activated on idle TTL (`activateAfterIdle`) or when the **actor's provider/model changes** (`activateOnProviderChange` — the prompt cache is invalidated anyway, so compact now; `types.ts:157-169`, `DataOmActivationPart.triggeredBy: 'threshold'|'ttl'|'provider_change'`, `types.ts:748`).
- **Data shapes.** OM state lives in (a) an `ObservationalMemoryRecord` storage row (active observations, token counts, buffering flags, `lastObservedAt` cursor), and (b) **marker data-parts written into the message stream itself**: `data-om-observation-start/end/failed`, `data-om-buffering-*`, `data-om-activation`, `data-om-status` (`types.ts:407-763`). The transcript is thus its own journal of memory operations — resumable, debuggable, UI-renderable.
- **What the actor sees.** System messages built from active observations, **one system message per cache-stable chunk** — "Each chunk is a separate system message for better LLM cache hit rates" (`observational-memory.ts:2496-2530`), new sections appended at message boundaries "for cache stability" (`:1884,1933`) — plus a continuation hint user message (`processor.ts:87-98`), plus recent unobserved raw messages. The §0.1 two-block description is accurate.
- **Retrieval.** Contrary to the design doc's "text-only, no vector" summary: OM now has an optional `retrieval` mode that preserves durable observation-group metadata, a `recallTool` (`packages/memory/src/tools/om-tools.ts:1147`) and an `onIndexObservations` callback for external indexing (`observational-memory.ts:285-297`). Semantic recall (vector) also still exists as a separate processor. Default remains non-vector.
- **Scope.** `'thread' | 'resource'` — resource scope observes *all* threads of a user, batching other threads' unobserved messages into the Observer call (`getOtherThreadsContext`, `observational-memory.ts:2539`).
- **Working memory** can be handed to OM (`manageWorkingMemory`) so the Observer extracts working-memory updates instead of the actor wasting tool calls; iterations that only called working-memory tools are excluded from task-completion scoring (`is-task-complete-step.ts:56-65`).
- **Concurrency honesty:** OM cycles are serialized by an in-process mutex with an explicit comment that distributed deployments need external locking or accept eventual consistency (`observational-memory.ts:325-336`).

### 3. Tool system

- Definition via `createTool` (`tools/tool.ts:575`) / `Tool` class (`:78`): `{ id, description, inputSchema, outputSchema?, suspendSchema?, resumeSchema?, requireApproval?: boolean | NeedsApprovalFn, execute(inputData, ctx) }`. Schemas are "PublicSchema" — Zod v3/v4, AI-SDK schema, JSON Schema, or StandardSchema, normalized through `packages/schema-compat` (an entire package that exists to paper over schema-ecosystem churn).
- Runtime validation of input, output, suspend and resume payloads (`tools/validation.ts`), plus `payload-transform.ts` for redacting/reshaping what gets persisted vs. displayed per phase (`transcript`/`approval`/`suspend`).
- Execution happens in a dedicated workflow step per call (`tool-call-step.ts:87`), fanned out with `.foreach(toolCallStep, {concurrency})` (`agentic-execution/index.ts:134`). Crucially, **concurrency is forced to 1 whenever any approval-capable or suspendable tool is in the step's active toolset** — even if not called — recomputed per step (`agentic-execution/index.ts:114-133`).
- Errors: a failed tool becomes an error tool-result message the model sees next iteration; unknown-tool-name errors likewise loop back with `isContinued = true` so the model can correct itself (`llm-mapping-step.ts:439-450`).
- Tool sources are unified: user tools, memory tools, MCP tools (`mcp` metadata), provider-executed tools, workflows-as-tools, agents-as-tools; there is a `tool-search` processor that indexes large toolsets and exposes only relevant ones per step (`processors/processors/tool-search.ts`).

### 4. Subagents & networks

- **Subagent = structural interface, not a class**: `SubAgent` (`agent/subagent.ts:43-99`) — `getDescription/getModel/getInstructions/generate/stream/resumeGenerate/resumeStream/hasOwnMemory/__setMemory/getMemory`. Registered under `agents: {...}` on a parent (`agent/types.ts:686`), each becomes a delegation tool.
- **Memory is injected downward by default**: if the sub-agent lacks its own memory, the parent's is set via `__setMemory` — sub-agents share the parent's store but run their own thread (goal judge forks a child thread with `{forkedSubagent: true, parentThreadId}` metadata, `goal-step.ts:294-311`). Context isolation is by-convention (thread separation), not structural.
- Sub-agent streaming chunks are forwarded into the parent's stream as `tool-output` chunks routed through the parent's output processors (`loop/workflows/stream.ts:141-181`), so users can filter/redact nested output — results return to the parent as ordinary tool results.
- Suspension propagates: a sub-agent suspending (approval) bubbles a `suspendPayload`/`resumeSchema` through the parent's tool-call step, and resume round-trips by `runId` even across page refreshes (persisted per-toolCallId metadata; see topic 8).
- **Agent networks** (`agent.network()`, `loop/network/index.ts`): a routing agent picks a primitive (agent/workflow/tool) per iteration via structured output, executes it, then an **LLM completion check** decides `isComplete` — wrapped in `.dountil(...)`. Their own exploration doc (`explorations/agent-network-vs-ralph-wiggum.md`) flatly admits the weakness: *"The LLM might think the task is complete when it isn't"*, and proposes exactly a Ralph-style external-validation bridge (`isTaskComplete` scorers + validation modes `verify|override|llm-only` are the shipped result). Networks are **incompatible with OM** (`network/index.ts:57-58` throws: network doesn't propagate the threadId/resourceId context OM requires).
- **Lifecycle management above the loop**: `AgentController`/`Session` (`agent-controller/`) — modes, per-mode model persistence, permission policies, task tools (`taskWriteTool`, `askUserTool`, `submitPlanTool`), session bus, thread locking, OM progress state. This is their coding-product harness (mastracode) extracted into core. Model-per-role is trivially available since every Agent/Observer/Reflector/judge/routing-agent takes its own model config.
- Cancellation: `abortSignal` threaded through; `streamUntilIdle` wrappers abort any prior wrapper for the same (thread, resource) scope (`agent/stream-until-idle.ts:1-20`).

### 5. Sessions / state / durability

- **Storage is one base class with 25 optional domain interfaces** (`storage/base.ts:31-56`: workflows, memory, schedules, channels, blobs, threadState, ...) — implementations in `stores/*` (libsql, postgres, convex, upstash, ...) implement what they can; a `filesystem.ts`/`inmemory-db.ts` default exists.
- **Workflow snapshots are the durability unit.** The agentic-loop persists snapshots **only** in `pending/paused/suspended` states — never `running` — and prunes them aggressively: "Agent-loop snapshots are pure resume artifacts — strip everything a resume never reads (stale suspend payloads, duplicated message arrays, AI SDK step history)" (`agentic-loop/index.ts:74-90`, `prune-snapshot.ts`). On terminal state, snapshot rows are **deleted**, best-effort (`stream.ts:224-236`). Streaming state itself is serialized into the suspend payload (`__streamState`, `loop.ts:124-135`) and restored on resume.
- **Non-serializable state is the confessed pain point.** Closures (tool `execute`, controllers, live MessageList) can't go in snapshots, so they built a per-run **RunScope** on the Mastra instance plus a legacy `_internal` bag, with dual read/write helpers to keep old tests working (`loop/run-scope-access.ts:1-60`), and — in the durable-agent design — a module-level `globalRunRegistry` **TTLCache (10 min, 1000 entries)** for workflow steps to reach live objects (`explorations/durable-agent.md`, Key Design Decisions #5/#7). Crash recovery across processes therefore depends on re-`prepare()` reconstructing the registry; a resume in a fresh process re-resolves tools by name from the Mastra registry.
- **Three durability tiers** (from `explorations/durable-agent.md`): resumable streams only (`createDurableAgent` — replay missed chunks via `CachingPubSub.subscribeFromOffset`); fire-and-forget local workflow (`createEventedAgent`); Inngest-backed distributed checkpointing (`createInngestAgent`). Same loop code, three executors, selected per deployment — plus the `MASTRA_EVENTED_EXECUTION=true` env flag that swaps `createWorkflow` for `createEventedWorkflow` inside the agent loop itself (`agentic-loop/index.ts:62`).

### 6. Async vs sync

- Everything is **stream-first**: the loop returns a `ReadableStream<ChunkType>` and `MastraModelOutput` wraps it with promise accessors. Request/response (`generate`) is the degenerate case.
- **PubSub** is the cross-process backbone (`events/pubsub.ts:19-66`): abstract `publish/subscribe/flush` with declared delivery modes `pull` (Redis Streams, GCP streamingPull — consumed by a long-lived `OrchestrationWorker`) vs `push` (in-process EventEmitter, broker→HTTP). The evented workflow engine, schedules, notifications and background tasks all ride topics on it.
- **Schedules**: a first-class `Schedules` service (`schedules/schedules.ts`) with agent schedules (`{agentId, cron, prompt, ifActive, ifIdle}`) and workflow schedules; the `Scheduler` (`workflows/scheduler/scheduler.ts:14-27`) ticks every 10s, claims due schedules via **compare-and-swap on `nextFireAt`** so N replicas polling shared storage fire exactly once, then publishes `workflow.start` — it never executes anything itself.
- **Signals** (`agent/signals.ts`): typed mid-run input injection — categories `user | state | reactive | notification`. Pending signals are drained **between iterations** at the loop boundary (`signal-drain-step.ts`; `agentic-loop/index.ts:96-115`): the response message boundary is marked, the messageId rotated, and signals appended so the next LLM call sees them. Schedules carry `ifActive`/`ifIdle` delivery policies (queue vs drop vs interrupt). `signals/github/` builds PR-subscription signals (subscribe to a PR, get notified of CI/review activity, permission-gated by author's repo permission) on this.
- **Background tasks** (`background-tasks/`): a tool call can be flagged to run in the background as its own workflow; `backgroundTaskCheckStep` injects completed results into a later iteration, and `streamUntilIdle` (`agent/stream-until-idle.ts`) keeps re-invoking the agent with a "these tasks finished" directive until the scope is idle — a perpetual-ish session built on **re-invocation, not resident processes**.

### 7. Pluggability

- **The Processor interface is the universal extension point** — and it has grown to **nine optional hooks** (`processors/index.ts:560-730`): `processInput`, `processInputStep`, `processOutputStream`, `processOutputStep`, `processOutputResult`, `processLLMRequest` (transient prompt rewrite, not persisted), `processLLMResponse` (response caching/mirroring), `processAPIError` (retry on 4xx with modified state), `computeStateSignal` (experimental cache-keyed state lane). Each hook has distinct persistence semantics documented in prose. Processors can `abort()` (tripwire), optionally with `retry`, and share a per-run `processorStates` map.
- Built-in processors: moderation, PII, prompt-injection, token-limiter, cost-guard, response-cache, structured-output, skills/skill-search, tool-search, message-selection, batch-parts, unicode-normalizer... (`processors/processors/`). Memory, OM, channels formatting, goal state, tool-loop-agent compat are *also* processors. It really is the kernel-seam equivalent — but as a fixed hook vocabulary on one interface rather than swappable services.
- Storage/PubSub/deployers/model-gateways are swappable base classes. DI is `RequestContext` + the Mastra registry; there is no typed requirement tracking anywhere — a missing tool/agent/model is a runtime `MastraError`.

### 8. Human-in-the-loop

- Three shapes (documented in `tools/hitl.md`): (1) `requireToolApproval: true` per call — stream closes on any tool call, resume with `agent.approveToolCall({runId})` / `.declineToolCall(...)`; (2) `requireApproval: true` (or a `NeedsApprovalFn`) per tool; (3) tool-initiated suspension — `execute` calls `await suspend(payload)` shaped by `suspendSchema`, resumes with data shaped by `resumeSchema` via `resumeStreamVNext(resumeData, {runId})`. `suspend()` resolves `void`; execute must return after it.
- Persistence of pending approvals/suspensions is **written into the last assistant message's metadata keyed by `toolCallId`** with the runId needed to resume "after page refresh" (`tool-call-step.ts:162-224`). The comment at `:187-193` records a real bug: keying by `toolName` collapsed two parallel calls to the same tool, losing one suspension irrecoverably (`AGENT_RESUME_NO_SNAPSHOT_FOUND`).
- Approval decisions are typed into the transcript: declined calls persist as `state: 'output-denied'` with `{approved: false, reason}` (`llm-mapping-step.ts:473-489`) so the model sees the denial.
- A declined/approval-pending turn is just a suspended workflow — indefinite waits are free because state is a snapshot row, not a held connection.

### 9. Provider abstraction

- `ModelRouterLanguageModel` (`llm/model/router.ts:110`) — magic-string ids (`'openai/gpt-4o'`) resolved through a **gateway chain** (`llm/model/gateways/`, incl. a hosted "mastra" gateway that can even take over OM server-side — `processor.ts:149-158`). It simultaneously supports **three AI-SDK spec versions** (LanguageModelV2/V3/V4 = AI SDK v5/v6/v7, `router.ts:33-46`) — the adapter tax of tracking Vercel's churn is a standing cost visible everywhere (`@internal/ai-sdk-v4`, `-v5`, `-v6` vendored packages).
- Model configs accept: id string, model instance, resolver function `(ctx) => model` (for per-request credentials), fallback arrays with retries, and **`ModelByInputTokens`** — token-tiered routing so e.g. OM uses a cheap model for small contexts and a bigger one past a size threshold (`observational-memory/model-by-input-tokens.ts`).
- Structured output is a processor (`processors/processors/structured-output.ts`) with a JSON-fallback path for models without native support (`tryGenerateWithJsonFallback`); capability metadata lives in a provider-capabilities registry (used e.g. by OM's `observeAttachments: 'auto'`, `types.ts:226-248`).
- Streaming deltas are a unified `ChunkType` vocabulary (`stream/types.ts`): model chunks, tool lifecycle chunks, `data-*` custom chunks (persisted unless `transient`), lifecycle (`start`, `step-finish`, `finish`, `error`, `tripwire`), plus domain chunks (`goal`, `is-task-complete`, OM markers).

### 10. Integration

- **Channels**: core abstraction (`packages/core/src/channels/`) with `ChannelProvider` implementations like Slack (`channels/slack/src/provider.ts`) that handle programmatic app creation via manifest API, OAuth install, webhook routes, streaming-vs-static chat drivers, per-tool display formatting, typing status. A channel is glue from platform events → agent invocation → formatted replies; agents don't know about it.
- **Deployment**: `deployers/cloudflare` etc. **bundle the Mastra HTTP server into the target platform** (babel transforms + wrangler config). Infra is not modeled — no provisioning of queues/DOs/webhooks; you get "your Node server, repackaged". The `ee/` + `packages/cli` "Studio" is the local UI. Infra concerns otherwise enter as config: storage adapter choice, pubsub choice, deployer choice.
- **Scorers/evals** (`packages/core/src/evals/base.ts`): `createScorer` builds multi-step judge pipelines (`preprocess → analyze → generateScore → generateReason`), each step either a function or an LLM-judge prompt-object; `ScorerJudgeConfig` supports **tools for the judge** (`base.ts:63-80`: "e.g. a goal judge that inspects the workspace with readonly tools to independently verify the agent's claims, rather than grading text alone"). Scorers attach to agents (sampled, async, persisted to a scores store) and double as live loop-control (`isTaskComplete`, goal).

---

## Judgments

**What they got right**

1. **The loop as a workflow on their own durable engine.** One suspend/resume/persistence substrate for workflows, agent turns, tool approvals, and networks. This is the single most validating fact for Alchemy's Phase 3 plan (loop runtime on CF Workflows / step machine over a journal).
2. **OM's continuous streaming fold.** Async buffering ahead of the threshold + instant activation means compaction almost never blocks the actor; markers-in-the-transcript make memory operations replayable and debuggable; cache-stable chunked system messages and append-at-boundary discipline protect prompt caches; force-activation on provider change is a subtle, correct insight (cache is per-provider anyway).
3. **Judges with tools and their own model/memory.** The goal judge independently verifies with readonly tools rather than grading prose, and judge *failure* is a first-class parked state with a reason — never a silent re-loop (`goal-step.ts:389-426`).
4. **Budget parking, not budget death.** Exhausted goal budgets park the objective visibly with "raise maxRuns to resume" instead of erroring or spinning.
5. **Suspend-only snapshot persistence + pruning + terminal deletion.** They learned that persisting running state is wasted write amplification and stale-row leakage; the checkpoint is only what a resume actually reads.
6. **Candid self-critique in-repo.** `explorations/agent-network-vs-ralph-wiggum.md` admits LLM self-assessed completion hallucinates, and the fix they shipped (external validation scorers) converged on maker/checker.

**What's weak / visibly regretted**

1. **Termination policy proliferation.** Five+ mechanisms (tool-call default, stopWhen, onIterationComplete, isTaskComplete scorers, goal step, delegation bail, tripwire) each mutate a shared `stepResult.isContinued` in sequence. The precedence is emergent from step order, not designed; `is-task-complete` and `goal-step` are near-duplicates ("Mirrors is-task-complete-step.ts but…", `goal-step.ts:93-99`).
2. **Non-serializable state whack-a-mole.** RunScope + `_internal` dual-write shims (`run-scope-access.ts`), a global TTL cache registry for durable runs, id-keyed internal-workflow registries scoped by runId to avoid clobbering (`stream.ts:205-218`). All of it exists because step state was never serializable-by-construction.
3. **Rename/deprecation churn.** Harness→AgentController (`harness/index.ts:1-8`), streamVNext→stream, `streamUntilIdle` deprecated into an option, three workflow engines plus an env-var switch, three concurrent AI-SDK spec versions, a whole `schema-compat` package. The framework absorbs ecosystem churn into its public surface.
4. **Feature-matrix incompatibilities.** OM×networks throws; OM requires a core feature flag (`request-response-id-rotation`); shareTokenBudget×async-buffering unsupported; resource-scope disables async buffering by default. Orthogonal-looking features aren't.
5. **God object + config-bag API.** `Mastra` with 10 type params, `agent.ts` at ~9k lines, options objects with dozens of `DynamicArgument` fields; the processor interface accretes a new hook for every new need. Nothing is denied by construction; every constraint is a runtime check.
6. **Distributed correctness is best-effort.** OM's in-process mutex with a "for distributed deployments… accept eventual consistency (acceptable for v1)" comment; scheduler CAS is right, but memory cycles and buffering coordination are single-process.

---

## Insights for Alchemy

1. **Mastra implements its agent loop as a workflow on its own engine → keep Alchemy's plan to make the loop runtime a thin layer over the durability substrate, and get suspend/resume from one mechanism.** Their reward: tool approval, human suspension, crash resume, and networks all reuse workflow snapshots. Our Phase 3 table (design §3.2 durability ladder) is the same idea done deliberately; the Ring DO + Workflow split should own *all* waiting (approvals included) the way their snapshots do.

2. **Five stacked continuation mechanisms mutating one `isContinued` flag → the Kernel must own a single halt-decision point.** Design §2.4 says "termination is policy"; Mastra shows what happens when policy has no positional home — stopWhen, hooks, scorers, and goal all fight over a mutable flag, with precedence defined by step order. Our `Halt`/`Check` refs at the iteration boundary are that positional home; resist ever adding per-call continue hooks to the Kernel surface (`onIterationComplete` is the cautionary tale).

3. **Goal-step precedence (judgeFailed → parked; complete → done; budget → parked; waiting → stop-but-stay-active) → adopt as the normative `check` semantics in §2.5.** Two specifics worth stealing: (a) **a failed judge is a typed exit, never a continue** — a thrown judge scores 0, indistinguishable from "keep working", so they detect `errored` explicitly and park (`goal-step.ts:389-397`); our kernel must distinguish `CheckFailed` from "off-goal verdict" in the Trace and surface it in `Err` or as an `Escalated` event. (b) **`waiting`** — the judge saying "stop and ask the human" without ending the run — is the escalation vocabulary §8.4 flags as undesigned; it's a third verdict (goal-met / off-goal / needs-input), not a halt.

4. **Budget exhaustion parks with a human-actionable reason and a resume path → `BudgetExceeded` should carry `{limit, used, resumeHint}` and the loop should be resumable after a budget raise.** Mastra's "raise maxRuns to resume" pattern means a budget ceiling is a checkpoint, not a tombstone. Our `Err` channel types the exit; the Ring DO should retain the fold + work item so re-dispatch after a budget edit continues rather than restarts.

5. **OM verified and deepened — §0.1's bullet needs two corrections.** Mechanics confirmed: 30k/40k *defaults* (configurable, optionally dynamic ranges), Observer/Reflector as separate cheap-model agents, two-block cache-stable rendering. Corrections: (a) OM is **not** strictly "text-only, no vector" anymore — optional `retrieval` mode + `recallTool` + `onIndexObservations` external indexing hook exist; (b) the headline innovation now is **async buffering + instant activation** (fold computed in the background at 20% intervals, swapped in at the threshold), not just the threshold pair. → Our `ObservationalMemory` Layer (§3.2 Memory Layers) should be specified as a *buffered* fold from day one: fold agents run as background invocations between iteration boundaries; the boundary step only *activates* the newest sealed fold. This also resolves the tension between "fold at every iteration boundary" and fold-LLM latency.

6. **Force-activation on provider change → `promptHash` alone is not the cache key; the fold/render cache key is `(provider, model, promptHash)`.** Mastra compacts eagerly when the actor's model changes because the provider cache is lost anyway (`triggeredBy: 'provider_change'`). Our renderer stability rules (§1.6) should state this, and the kernel may treat model swaps as free compaction points.

7. **OM markers as data-parts in the transcript → write fold/checkpoint lifecycle events into the Trace itself, not a side table.** Their `data-om-observation-start/end/failed`, `buffering-*`, `activation` markers make memory operations replayable, resumable after crash-mid-observation, and renderable in a UI — one representation. This is exactly design §2.3's "the persisted event stream is the Trace; do not invent a second representation," now with a proven concrete schema to crib (cycleId shared across start/end/failed; config snapshot embedded in the marker).

8. **RunScope/TTL-registry pain → §2.4's "StepState serializable by construction, no handles" rule is the single highest-leverage decision in our design; enforce it structurally.** Mastra's entire run-scope/`_internal`/globalRunRegistry apparatus exists because live objects (tool closures, MessageList, controllers) leak into step state. Our rule that live resources come only from Scoped Layers and never from state is what makes `stash` trivial. Add a conformance test: every `StepState` must survive `structuredClone` + process restart.

9. **Keying suspensions by toolName lost parallel calls (`AGENT_RESUME_NO_SNAPSHOT_FOUND`) → the tool-pairing invariant (§2.4) must extend to suspension identity: all pending-call bookkeeping keys on `callId`, never name.** Their fix-comment (`tool-call-step.ts:187-193`) is a purchased lesson; encode it in the property tests for the step machine (parallel identical tool calls suspend and both resume).

10. **Approval-capable tools force sequential execution (`agentic-execution/index.ts:114-133`) → HITL interacts with concurrency; make it a kernel obligation.** If a suspendable/approval tool is in the active toolset, parallel tool fan-out must degrade to sequential (or the journal must support multiple concurrent suspensions — Mastra chose sequential). Our `AI.concurrency` + human-backed-tool Layers need this rule stated in §2.4's kernel obligations.

11. **Snapshot policy: persist only pending/suspended, prune to resume-essentials, delete on terminal → adopt verbatim for the Ring DO journal.** "Snapshots are pure resume artifacts" is the right doctrine; combined with our fold-as-checkpoint it means the DO stores: the fold, the Trace, and *only for suspended runs* a pruned resume record.

12. **Signal drain at the iteration boundary + `ifActive`/`ifIdle` delivery policy → mid-run stimuli need a typed place in our loop runtime.** Design §2.5's trigger model wakes loops but says nothing about input arriving *during* a run (human interjection, GitHub activity on the PR being worked). Mastra's answer: queue signals, drain between iterations, rotate the message boundary, let schedules declare interrupt-vs-queue-vs-drop semantics. Recommend: a `KernelEvent`-driven stimulus queue per run, drained at the iteration boundary (never mid-turn), with delivery policy owned by the harness — no new term needed.

13. **Scheduler CAS-claim on shared storage (`scheduler.ts:14-27`) → our `AI.every` on Cloudflare should prefer per-ring DO alarms precisely because they make this problem vanish.** Mastra needs compare-and-swap because N stateless replicas poll one table. A Ring DO is single-writer by construction — cite this as a justification in §3.2's trigger-physics table, and only fall back to CAS if rings ever share a scheduler.

14. **The 9-hook Processor interface is the counterfactual for "the Kernel has no component vocabulary" (§0.4 — nuance needed).** Honest correction to our doc: Mastra *did* move memory/compaction into plugins (processors), so "such components are top-level framework concepts" is stale as written. The real difference is that their extension surface is a **closed hook vocabulary on one interface** that grows a method per need (LLM-request rewrite, API-error retry, state signals...), each with bespoke persistence semantics — whereas ours is open: seams are ordinary `Context.Tag`s a harness pulls privately. Update §0.4's phrasing to target hook-vocabulary accretion, which is the actual failure mode observed.

15. **Networks (LLM routing + LLM completion self-assessment) underperformed and got patched with external validation → strongest possible corroboration for `AI.check` and for giving fan-out/routing no term.** Their own exploration doc concedes the completion check hallucinates and Ralph-style programmatic validation is the fix; the shipped `isTaskComplete`/goal machinery is maker/checker retrofitted. Alchemy has this positionally from day one. Also note their routing agent is a *charter-less* dynamic dispatcher — precisely the shape §8.5 rejects as "a pipeline, not a loop"; Mastra's experience (2,708-line network module, OM-incompatible) supports keeping routing as prose delegation inside charters.

16. **Judge-with-tools and judge-with-own-memory (goal scorer forking a `goalJudge` thread) → our Judge agents should get read-only tool Layers *and* their own fold/trace scope.** We already planned per-agent tool physics (BashReadOnly); Mastra adds: the judge's deliberation is itself a session worth remembering across iterations of the same run (their judge thread is keyed by `threadId-goalId`). Consider: the check agent's context persists per work-item, folded separately from the doer's.

17. **`ModelByInputTokens` tiered routing and model-resolver functions → model choice is a Layer concern, and folds especially want cheap-model routing.** OM defaults to gemini-flash for Observer/Reflector while the actor runs a frontier model. In Alchemy, `AI.fold(Scribe)`'s Scribe should typically be bound to a cheaper `AiLanguageModel` Layer than the doer — per-agent model physics is the same mechanism as per-agent tool physics, worth an explicit example in §4.2.

18. **Token accounting is a giant hidden subsystem (`token-counter.ts`, 1,889 lines) → budget enforcement (§1.2.2 `AI.budget({tokens})`) needs a specified counting strategy per provider.** Mastra counts with model-context-aware tokenizers, caches counts per message, and persists pending-token counters on the OM record. Our budget ceilings are typed, but the *measurement* is harness work we haven't scoped; flag it in §6 risks.

19. **Channels (Slack manifest/OAuth/webhook provisioning in-framework) vs. our EventSource model → validation that "declaring the subscription provisions the wire" is the differentiator.** Mastra's Slack channel provisions the Slack app imperatively at connect-time through the running server; deployers just repackage the server. Nobody in their stack can type-check "this agent needs a Slack channel" — it's runtime config. Our `EventSource<In, Channel>` → `Req` → Layer → Alchemy-provisioned webhook chain (§1.2.3) has no analogue in Mastra and is genuinely novel; keep it front and center.

20. **Declined approvals persist as typed `output-denied` results the model sees → denial is information, not absence.** In our step machine, a rejected `Ask`/`Approve` should produce a typed `ToolResult` variant (denied + reason) that flows into the next model call, not a dropped call — matches their `llm-mapping-step.ts:473-489` and prevents the model retrying blindly.

### Where Mastra's experience contradicts alchemy-ai-design.md

- **§0.1 (Mastra OM bullet):** "Text-only, no vector/graph stores" — now inaccurate; OM has an optional retrieval mode, a recall tool, and an external-indexing hook (default remains non-vector). Also the load-bearing mechanism today is background buffering + instant activation, worth adding to the bullet.
- **§0.4 / claim (4) "kernel has no component vocabulary... central inversion relative to Mastra":** partially stale — Mastra moved memory/compaction into its plugin pipeline. The accurate contrast is *closed hook vocabulary + runtime wiring* vs. *open typed seams + compile-time requirements*. Recommend rewording so the claim survives scrutiny.
- **§2.5 loop runtime:** no provision for mid-run input. Mastra's signal-drain-at-boundary + ifActive/ifIdle policy shows this is a real need (their GitHub signals package is built on it); our design should name where mid-run stimuli enter (iteration boundary via the harness), or state explicitly that they are deferred.
- **No contradiction found** for: fold-as-unit-of-memory-and-durability (their persisted-step-result ≈ folded state supports it), capability denial by absence (no analogue — everything is runtime-granted in Mastra, and their permission system is imperative `PermissionPolicy` checks in AgentController), or exit-signal-as-type (their `isComplete` booleans are exactly the untyped version we're replacing).

### Things I could not verify

- Git history/blame beyond the shallow clone tip — deprecation narrative is reconstructed from in-tree comments, `@deprecated` tags, `explorations/*.md`, and the `harness/` alias module, not commit history.
- Runtime behavior (no code executed) — all claims are static-analysis of source + in-repo docs.
- The docs-site prose (mastra.ai) for OM — the uploaded docs dump (`uploads/mastra-0.md`) was only the repo README; OM findings above are from source, which is stronger anyway.
