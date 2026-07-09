# Flue (withastro/flue) — Study for Alchemy AI

Studied at `.vendor/flue` (shallow clone, HEAD = 2026-07-03 "Settle tool state deterministically at submission terminalization"). Version `@flue/runtime@1.0.0-beta.9`; first beta shipped **2026-06-16** — the project is ~3 weeks old as a public artifact and moving fast.

---

## 1. Architecture overview

Flue is a **compile-to-server agent framework**: a project of `agents/<name>.ts`, `workflows/<name>.ts`, and `channels/<name>.ts` modules is discovered by the CLI (`@flue/cli`, a Vite build graph) and compiled into a deployable HTTP server for exactly two targets — `node` or `cloudflare` (`packages/cli/src/lib/config.ts:23-31`). Everything else in the README's "Deploy Anywhere" list (GitHub Actions, GitLab CI, Daytona, Render, Fly, AWS, SST, Docker…) is a *hosting guide for the Node build* (`apps/docs/src/content/docs/ecosystem/deploy/` has one md per host), not a distinct runtime. So the honest answer to "how does one codebase target all these?" is: **it doesn't — it targets two runtimes, and the rest is docs**.

### Package map

| Package | Role |
|---|---|
| `@flue/runtime` | The harness: sessions, pi-loop wrapper, canonical conversation store, submission durability, sandbox adapters, tool/skill/action/workflow definitions, Hono app (`runtime/flue-app.ts`) |
| `@flue/cli` | Vite build/dev, discovery of `agents/`/`workflows/`/`channels/`, `.flue/` source-root convention, `with { type: 'skill' }` import-attribute plugin, `flue add` blueprint printer |
| `@flue/sdk`, `@flue/react` | Clients for deployed agents (history/updates/observe/wait, SSE + long-poll) |
| `@flue/postgres`, `mysql`, `libsql`, `mongodb`, `redis` | `PersistenceAdapter` implementations of one storage contract |
| `@flue/opentelemetry` | Instrumentation adapter (observe + interceptor pair) |
| `@flue/slack`, `github`, `discord`, `teams`, `telegram`, … (17) | **Channels**: verified-ingress HTTP packages |
| `blueprints/` | Markdown implementation guides `flue add <kind> <name> --print \| codex` pipes to *your coding agent* |

### The pi relationship — claim verified

Flue's loop **is pi's loop**. `packages/runtime/package.json` depends on `@earendil-works/pi-agent-core@^0.80.2` and `@earendil-works/pi-ai@^0.80.2`. The Session constructor instantiates pi's `Agent` directly:

```684:697:.vendor/flue/packages/runtime/src/session.ts
		this.agentLoop = new Agent({
			initialState: {
				systemPrompt,
				model: this.config.model,
				tools,
				messages: previousMessages,
				thinkingLevel: this.config.thinkingLevel ?? 'medium',
			},
			getApiKey: (provider) => this.getProviderApiKey(provider),
			onPayload: (payload, model) => this.applyProviderPayloadOverrides(payload, model),
			streamFn: this.emitTurnRequestAndStream,
			toolExecution: 'parallel',
			sessionId: this.affinityKey,
		});
```

`AGENTS.md:15` states it in the terminology table: "Turn — one LLM round-trip inside pi-agent-core." What Flue reuses: the act–observe turn loop, tool dispatch, message/tool-pairing state, provider streaming (`streamSimple` from `pi-ai/compat`), the model catalog and cost math. What Flue adds around pi: **everything durable** — the canonical conversation event stream, the submission lifecycle, recovery, compaction persistence, sandboxes, channels, HTTP. Flue subscribes to pi's event stream and journals every delta (`session.ts:700-984`); pi itself is treated as a volatile in-memory executor whose state is *rebuilt by projection* from Flue's own records after any interruption.

The layering, bottom to top:

```
pi-ai (providers, streaming, models)
  └ pi-agent-core Agent (the turn loop; exit = "no more tool calls" or terminate:true)
      └ Session (session.ts, 3682 lines): journals pi events → canonical records;
          compaction; result tools; task/subagent delegation; recovery/resume
          └ Harness (harness.ts): named sessions over one agent instance; shell; fs
              └ AgentSubmission coordinator (per target): durable queue, leases,
                  attempts, reconciliation  [cloudflare/agent-coordinator.ts,
                  node/agent-coordinator.ts]
                  └ flue() Hono app: /agents/:name/:id, /workflows/:name,
                      /channels/<name>/..., /runs/:id
```

### Vocabulary (AGENTS.md:7-18)

Agent definition (`defineAgent(initializer)`) → **AgentInstance** (URL `<id>`, one per conversation-worthy identity, e.g. one per GitHub issue) → Harness → **Session** (named; `"default"`) → **Operation** (`prompt`/`skill`/`task`/`shell`) → **Turn** (pi round-trip). Workflows are separate finite invocations (`runId`); "runs are workflow-only."

---

## 2. Per-topic findings

### 2.1 The loop

- **Core loop is pi's**, not Flue's (above). Flue drives it via `agentLoop.prompt(...)` / `agentLoop.continue()` and `waitForIdle()` (`session.ts:2798-2800`).
- **Exit conditions**, layered:
  1. pi default: model emits no tool calls (plus pi's own internal iteration limits — `session.ts:3534` "pi-agent-core has its own iteration limits as the final ceiling").
  2. **Typed result exit**: when a call declares a valibot `result` schema, Flue injects framework tools `finish` and `give_up` (`result.ts:15-16`); a successful `finish` sets `terminate: true` so pi ends the loop after the current tool batch (`result.ts:171-173`); schema-invalid `finish` args **throw**, which pi encodes as a tool-error the model sees and can correct (`result.ts:220-226`). If a turn ends with neither tool called, Flue sends a reminder prompt and loops, up to `MAX_FOLLOWUPS = 32` (`session.ts:3545-3568`).
  3. Turn-level recovery loop around pi: context-overflow → compact → `continue()`; transient model error → exponential backoff retry, budget computed from **durable history** ("count trailing consecutive errors from durable history… identical to the one a restart computes", `session.ts:2771-2792`), max 3 (`session.ts:165`).
- There is **no outer goal/task loop** — no judge, no iteration-until-spec-met construct. The closest thing is the follow-up nag in `runWithResultTools`. Everything above the turn is either a workflow (plain TypeScript) or the app's own code.

### 2.2 Memory & compaction

- **Continuity = the canonical conversation stream.** Every agent instance owns one append-only, parent-linked event log (`conversation-records.ts`, reduced by `conversation-reducer.ts:21-127`): `user_message`, `assistant_message_started/text_started/text_delta/text_completed/reasoning_*/tool_call/message_completed`, `tool_outcome`, `tool_results_committed`, `compaction`, `child_session_retained`, `submission_settled`, advisory signals. Model context is a **projection** of this log (`conversation-projections.ts`), rebuilt on every operation (`rebuildCanonicalContext`). "Later input → rebuilds context → continues the conversation" (`durable-execution.md:15-19`).
- **Compaction is a record in the log, not a mutation.** `runCompaction` summarizes with an LLM (optionally a different `compaction.model`), then appends `{ type: 'compaction', summary, firstKeptEntryId, sourceLeafId, tokensBefore, usage }` (`session.ts:2984-2996`); projection renders summary + kept tail. Two triggers: threshold (`contextWindow - reserveTokens`, `compaction.ts:1-8`, checked after every assistant message at `session.ts:2842-2861`) and overflow (provider error → compact → auto-retry the turn, `session.ts:2760-2770`). Defaults are model-aware (`deriveCompactionDefaults`, `compaction.ts:51-72`: reserve capped at model maxTokens, floor for tiny windows). Config is just `{ reserveTokens, keepRecentTokens, model } | false` (`agent-definition.ts:213-228`). Compaction cost is folded into the triggering call's reported usage (`session.ts:2863-2868`).
- Split-turn compaction is handled (cutting mid tool-batch keeps a turn prefix — `session.ts:2925-2931`).
- **No observational memory, no reflection, no vector store, no cross-instance memory.** One strategy (summarize-and-keep-tail), hardcoded; the only pluggability is the summarization model. Memory across *instances* doesn't exist — an instance IS the memory boundary.

### 2.3 Tool system

- `defineTool({ name, description, input: valibot, output?: valibot, run({ input, signal, ... }) })` (`tool.ts`; migration from `parameters/execute` was a beta.3 breaking change). Output is validated/serialized by the framework; structured output is persisted on the canonical `tool_outcome` record separately from the model-facing text (`conversation-reducer.ts:39-48`).
- **Builtins are created against the sandbox env**: `read`, `write`, `edit`, `bash`, `grep`, `glob`, plus `task` when delegation is enabled (`agent.ts:40-51`). Tools receive a `SessionEnv` — the sandbox abstraction — so **tool physics = which sandbox the agent config chose**. The bash tool's timeout contract is instructive: model-facing seconds param → `timeoutMs` hint forwarded to the provider's native timeout + local `AbortSignal.timeout` backstop; timeout returns a *recoverable* exit-124 result to the model, host abort rethrows (`agent.ts:202-257`).
- `activate_skill` and `read_skill_resource` are framework tools for progressive skill disclosure (`agent.ts:321-359`, `59-75`).
- MCP: `connectMcpServer` (`mcp.ts`) adapts MCP tools into the same tool surface; JSON-schema validation is codegen-free for workerd compat (CHANGELOG #400).
- **Permissions: none.** No allow/deny policy, no approval gate on tools. Constraint = don't put the tool in the array (capability-by-omission, same spirit as Alchemy's absence-of-ref, but *value-level* and invisible to types). Sandbox choice is the only blast-radius control.

### 2.4 Subagents — build and management

- Declared as **named `AgentProfile`s in the parent's config** (`subagents: [profile]`), validated for circularity and duplicate names (`agent-definition.ts:290-308`). Profiles are self-contained for capability/identity: "instructions, tools, skills, subagents come only from the profile — omitted means none, never the parent's. Environment fields (model, thinkingLevel, compaction) inherit" (`harness.ts:208-213`).
- Spawned two ways: model-invoked `task` tool (whose description embeds the roster of available agents — `agent.ts:293-312`) or programmatic `session.task()`. Depth cap `MAX_DELEGATION_DEPTH = 4` (`session.ts:164`).
- Isolation: child gets its **own conversation** (kind `'task'`, parent-linked via a durable `child_session_retained` record carrying `parentToolCallId` as "the durable join key for recovery", `session.ts:281-297`, `harness.ts:284-321`), its own session name `task:<parent>:<taskId>`, optionally its own `cwd` (a path-scoped view of the parent's sandbox — `createCwdSessionEnv`, `sandbox.ts:91-114` — **not** a separate sandbox).
- Result return: only the final assistant text (plus optional structured result) resolves the parent's `task` tool call — the subagent-summary pattern.
- Lifecycle/durability: children run **inside the parent operation's durability envelope**; subagent profiles "must not declare durability" (`agent-definition.ts:301-306`). Recovery reattaches an in-flight child from its durable records and resolves the parent's tool call from the resumed result (`durable-execution.md:70-78`, `session.ts:3299-3355`). If the parent's budget dies first, the child's `task` call settles interrupted with a link to the retained child transcript.
- **No management beyond this**: no supervision, no restart policy, no inter-agent messaging; a "team" is a tool-call tree.

### 2.5 Sessions / state / durability (the headline feature)

Two-plane design, and the separation is explicit: mutable coordination state vs. append-only truth. "Mutable submission claims and leases remain operational state rather than a second transcript" (`durable-execution.md:23`).

**Plane 1 — Submission lifecycle** (`agent-execution-store.ts`): every external input (HTTP prompt or `dispatch()`) is admitted as an `AgentSubmission` `{ status: queued | running | terminalizing | settled, attemptCount, maxRetry, timeoutAt, ownerId, leaseExpiresAt, abortRequestedAt }` (lines 29-61). The store contract (lines 130-276) is written in terms of observable atomicity ("two concurrent claims must never both succeed") so non-SQL backends can implement it; verified by exported contract-test suites (`@flue/runtime/test-utils`). Key mechanics:

- **Idempotent admission** keyed by dispatchId; exact replay returns the prior submission, same id + different payload = conflict (lines 163-169).
- **Per-session FIFO**: only the oldest unsettled submission of a session is runnable (lines 136-142) — one durable inbox per agent instance.
- Claim = atomic CAS; leases renewed by heartbeat on Node, **advisory (0) on Cloudflare** because the DO is single-threaded ("leases are advisory-only… the Node coordinator uses real lease expiry with heartbeat renewal for multi-process safety", `cloudflare/agent-coordinator.ts:463-473`).
- **Attempt markers**: durable "this attempt started" evidence inserted before the fiber starts, deleted at settlement; a fresh marker suppresses reconciliation of a possibly-live attempt; marker-scan failure degrades to empty-set because "double-processing is bounded by the claim CAS" (`agent-execution-store.ts:88-99`, `agent-coordinator.ts:428-449`).
- Settlement for direct submissions is **two-phase**: reserve the exact canonical settlement record as an obligation → append it to the conversation → finalize (lines 227-238; replay path at `agent-coordinator.ts:416-427`).

**Plane 2 — Canonical conversation records**: the write-ahead journal at *delta granularity* — every text/thinking delta is enqueued, every block completion and tool outcome is awaited-durable before proceeding (`session.ts:730-967`). Tool outcomes get deterministic ids derived from `(assistantMessageId, toolCallId)` so replays collide idempotently (`session.ts:871-872`).

**Recovery** decides "from the canonical conversation stream alone" (`durable-execution.md:39`): classify the state after the input entry (`classifyConversationSubmission`) → `completed` / `resume` (continue a partial assistant from durable deltas) / `tool_results_partial` or `tool_use_unresolved` → **repair the batch**: recorded outcomes preserved, unresolved calls get an explicit interrupted-error result, **never re-executed** (`session.ts:3223-3297`); only when nothing was durably persisted may the provider be re-dispatched once (at-least-once). Terminalization (retries exhausted / timeout / abort) settles the conversation to "a deterministic rest state": every unresolved tool call gets an interrupted `tool_outcome`, partial streams complete as aborted, a terminal advisory carries `attributes.interruptedTools` — "No tool call is ever left permanently unresolved" (`durable-execution.md:43`). This is the tool-pairing invariant, enforced at the persistence layer.

**Cloudflare wiring**: one DO per agent instance; DO SQLite holds stores; drivers are DO startup (`onStart` → reconcile), a self-rearming 30s `schedule()` wake, and the **Cloudflare Agents SDK's `runFiber`/`stash`/`onFiberRecovered`** (Project Think's API) — Flue stashes only `{ submissionId, attemptId }` and uses fiber recovery merely as a *wake signal* that requests recovery and re-reconciles (`agent-coordinator.ts:60-70, 280-293, 535-560`). The actual resume state is always the canonical stream, not the fiber snapshot.

**Node wiring**: same submission store over `node:sqlite` (in-memory by default; `db.ts` default-exports a `PersistenceAdapter` for Postgres etc.). Startup reconciliation + periodic expired-lease scans; **single-live-owner rule**: "a shared database supports restart or host-replacement recovery; it does not make active-active processing safe" (`durable-execution.md:51`).

**Workflows are NOT durable**: "Flue does not checkpoint arbitrary TypeScript execution and resume the function from its last completed line… A retry creates a new invocation" (`durable-execution.md:86-99`). Durable execution is an *agent-submission* property only.

**What is not durable**: programmatic `session.prompt()/task()` calls from your own code ("no durable submission to resume from", `durable-execution.md:78`), sandbox filesystem state (`durable-execution.md:80-82`), workflow progress.

### 2.6 Async vs sync

- The distinction is **`kind: 'user'` vs `kind: 'signal'`** on one unified `DeliveredMessage`, not sync vs async: `user` = a person in a 1:1 chat; `signal` = structured world events (webhooks, schedules, multi-user threads) with `type`, string `body`, flat string `attributes`, rendered into context in an XML envelope (`renderSignalMessage`; tagName validated against injection — CHANGELOG "Signal tagName must be a valid XML tag name").
- Both direct HTTP prompts and `dispatch()` enter *the same durable queue* — and as of the current unreleased changes **sync request/response is gone entirely**: "`?wait=result` is removed; agent prompts always return a 202 admission… read the reply from the conversation stream" (CHANGELOG Unreleased). The connection "observes the work but does not own it" (`durable-execution.md:37`).
- Long-running work = the submission timeout (default 1h) + retries (default 10) envelope.
- **Scheduling is userland**: the `node-schedules` example wires `croner` in `app.ts` calling `dispatch(...)` (`examples/node-schedules/src/app.ts:11-29`). No framework trigger/cron primitive exists. Long-lived sockets/polling transports are explicitly out of scope for channels (`channels.md:326-329`).

### 2.7 Pluggability

Four adapter seams, all value-level factory interfaces:

1. **Sandbox** — `SandboxFactory.createSessionEnv(): SessionEnv` (9 fs methods + `exec`; `sandbox.ts:218-236`). Built-ins: `local()` (host fs + spawn, env allowlist — `node/local.ts`), `bash(just-bash)` virtual in-memory (`sandbox.ts:120-130`), `cloudflareSandbox(getSandbox(env.Sandbox, id))` wrapping `@cloudflare/sandbox` structurally so runtime has no CF dependency (`cloudflare/cf-sandbox.ts:16-56`). Third-party sandboxes (E2B, Daytona, Modal, Vercel…) are **blueprints** (`blueprints/sandbox--*.md`) that a coding agent implements *into your project* as `src/sandboxes/<name>.ts` — Flue deliberately does not ship them as packages. Cancellation contract: prefer `timeoutMs` (most provider SDKs are signal-blind), signal as backstop; centralized pre/post abort checks (`sandbox.ts:198-269`).
2. **Persistence** — `PersistenceAdapter.connect() → { executionStore, runStore, eventStreamStore, conversationStreamStore, attachmentStore }` (`agent-execution-store.ts:287-342`), with a schema-version obligation (fail loudly on unknown/newer version) and published contract tests.
3. **Observability** — `instrument({ observe, interceptor, dispose })` (`instrumentation.ts:8-13, 62-94`): an event subscriber plus an **execution interceptor** that wraps every model stream iteration and tool run (`wrapProviderStream`, `session.ts:388-412`) — that's how OTel gets spans with correct timing. `@flue/opentelemetry` projects to pinned GenAI semconv.
4. **Providers** — `registerProvider`/`registerApiProvider` over pi-ai's catalog (`internal.ts:143-180`); `workers-ai-provider.ts` adds Workers AI bindings.

Not swappable: the loop (pi), compaction strategy, the submission state machine, conversation record schema.

### 2.8 Human-in-the-loop

**Effectively absent.** A grep for approval/escalation surfaces nothing but the headless-mode system-prompt line: "You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input" (`context.ts:138`). There is no approval tool, no pause-for-human, no `waitForEvent` analog. What exists:

- **HTTP route guards**: an agent module may export `route: AgentRouteHandler` — literally a Hono `MiddlewareHandler` (`types.ts:35`) — run before agent prompt/stream routes (`runtime/flue-app.ts:430-433`); workflows likewise (`route` for POST, separate `runs` export to expose run inspection). This is authn/z, not HITL.
- **Abort**: `POST /agents/:name/:id/abort` is a durable, distinct terminal outcome ("abort is a distinct terminal outcome, not a failure", `durable-execution.md:55`) — the only human control over running work.

So Flue's autonomy dial has two positions: gate the input (middleware) or kill the work (abort). Nothing between.

### 2.9 Provider abstraction

- Model = one string `'<provider>/<model>'` resolved against pi-ai's catalog, with `registerProvider` overrides winning (`internal.ts:143-180`). Per-agent, per-subagent-profile, per-call (`prompt({ model })`), and per-compaction models are all just strings.
- Streaming is pi-ai's `streamSimple`; Flue wraps the stream for journaling + interception. Thinking levels `off|minimal|low|medium|high|xhigh` (`agent-definition.ts:16-23`).
- Usage/cost normalized from pi-ai `Usage` into Flue `PromptUsage` at the persistence boundary (`usage.ts:48-51`), deliberately decoupled "so future divergence in pi-ai doesn't leak into the runtime package's public API."

### 2.10 Integration: channels, deploy, CLI/runtime split, SDK

- **Channels are verified-ingress libraries, nothing more.** A channel package owns "request authentication and signature verification, provider handshakes, body limits, parsing, typed provider payloads"; the application owns "provider SDK client, OAuth/token storage, delivery deduplication, business persistence" (ownership table, `channels.md:73-85`). E.g. `createGitHubChannel` verifies `X-Hub-Signature-256` over exact delivered bytes before your handler runs, answers `ping` internally, is **stateless and does not dedupe** (`github/src/index.ts:87-95`, `webhook.ts:44-47`). The handler then calls `dispatch(agent, { id: channel.conversationKey(ref), message: { kind: 'signal', ... } })` (`examples/github-channel/src/channels/github.ts:11-78`).
- **Crucially: nothing provisions the webhook.** The user creates the GitHub webhook/Slack app manually, sets the secret env var, and points it at `/channels/github/webhook` (route derived from the *filename* — `channels.md:91-101`). Flue's `flue add channel X --print | codex` pipes a markdown blueprint into your coding agent to write the integration module — provisioning-by-LLM-blueprint instead of provisioning-by-IaC.
- **conversationKey is the load-bearing bridge**: a canonical string identity (`github:v1:owner:o:repo:r:issue:n`) becomes the agent **instance id**, so a GitHub issue = a durable agent instance = one conversation; and the agent initializer receives that id and **parameterizes its tools from it** — `tools: [commentOnIssue(channel.parseConversationKey(id))]` (`examples/github-channel/src/agents/assistant.ts:4-8`). Keys are "canonical identifiers, not authorization capabilities" (`channels.md:232-234`).
- **CLI/runtime split**: CLI discovers modules from `.flue/` (preferred) or `src/` (`config.ts:37-39` — the repo's own `.flue/` holds its dogfood workflows), builds per-target entries (Node HTTP listener vs generated DO classes + wrangler merge — `build-plugin-cloudflare.ts`, `cloudflare-wrangler-merge.ts`), and implements `with { type: 'skill' }` / `with { type: 'markdown' }` import attributes as a Vite plugin that packages the skill directory (with secret-file exclusions) into the bundle (`vite-import-attribute-plugin.ts:12-33`).
- **SDK**: `client.agents.send/wait/history/updates/observe/abort`, `client.runs.*`; results are read from the durable conversation stream at a resumable offset, SSE or long-poll. React hooks in `@flue/react`.
- **Skills**: three sources — build-time `import skill from './SKILL.md' with { type: 'skill' }`, runtime `defineSkill({...})` in TS (`skill-definition.ts:18-34`), and workspace discovery of `AGENTS.md`/`CLAUDE.md` + `.agents/skills/**/SKILL.md` from the *sandbox cwd* (`context.ts:27-60`) — discovered skills re-read SKILL.md at activation so mid-session edits apply and malformed files can't brick init.

---

## 3. Judgments

### What they got right

1. **One append-only conversation log as the single source of truth, with model context as a projection.** Memory (compaction), durability (recovery), client UX (history/streaming at offsets), and telemetry all read the same records. Compaction-as-a-record (`firstKeptEntryId` + summary) instead of destructive rewriting means recovery, audit, and rendering can never disagree. This is the strongest design in the codebase and it is exactly Alchemy's "the persisted event stream is the Trace" claim, independently converged on.
2. **The conservative recovery doctrine is precisely articulated and enforced at the storage layer**: reuse durable deltas, never re-execute a tool without a durable outcome, mark unknown outcomes as interrupted-error, at-least-once only for the provider call when nothing persisted (`durable-execution.md:39-43`). And terminalization guarantees "no tool call is ever left permanently unresolved" — the tool-pairing invariant survives even abandonment.
3. **Submission mechanics are genuinely production-grade**: idempotent admission, CAS claims, per-session FIFO, attempt markers with a graceful-degradation rationale, two-phase settlement, target-appropriate leasing (advisory on single-threaded DOs, heartbeat on Node). The contract is specified behaviorally and shipped with contract tests for adapter authors.
4. **Honest platform asymmetry.** They document exactly what Node can't do (no wake after death without a replacement process, single-live-owner) instead of pretending parity. The comparison table in `durable-execution.md:61-68` is a model of honest docs.
5. **Channel scope discipline**: verified ingress only, provider-native types, outbound stays in the provider's own SDK. They explicitly refused to build a universal channel client ("provider APIs… are too different for a shared outbound abstraction to preserve their capabilities well", `channels.md:277-279`).
6. Tool-level pragmatics: the bash timeout dual contract (`agent.ts:202-257`), split-turn compaction, transient-retry budgets computed from durable history so live and post-restart behavior are identical (`session.ts:2771-2782`).

### What's weak

1. **No loop above the turn.** No goal loop, no judge/verifier, no budget beyond `{ maxAttempts, timeoutMs }`, no stall detection, no health signals. "Autonomous agents" here means "a durable chat participant with tools," not a converging loop. Everything Voss/swyx call rings 3–5 is the user's problem.
2. **No human-in-the-loop primitives at all** (§2.8). For a framework whose pitch includes autonomy, having only middleware-gating and abort is a real gap — no approval tool, no durable wait-for-human, no escalation.
3. **No capability/permission model.** Tools are granted by array membership; nothing constrains a tool at runtime, nothing separates a verifier's toolbox from a doer's (there is no verifier). Sandbox choice is the only isolation.
4. **Massive churn, reset-only persistence.** Beta.1 → beta.9 in three weeks with repeated breaking changes: `parameters/execute` → `input/run`; workflows redefined around Actions; `?wait=result` sync mode added then removed; `client.agents.prompt()` removed; dispatch payload reshaped; "persisted storage is reset-only schema v5… no migration, consistent with the pre-1.0 reset-only policy" (CHANGELOG Unreleased). The `plans/` directory (channel roadmaps, a pending "vite-unified-build-and-skill-reference-migration") confirms the surface is still being found. The durable *substrate* (canonical records, submissions) has been the stable core; everything above it wobbles.
5. **Session.ts is a 3,682-line god-object** doing journaling, projection, compaction, recovery, delegation, result tools, and telemetry. The docs' clean conceptual planes are not reflected in the code's seams.
6. **Workflow durability is punted** — reasonable scoping, but it means the only "structured automation" story loses all progress on restart, on both targets, and on Node an interrupted run is left permanently `active` (`durable-execution.md:88`).
7. **Scheduling and event-source provisioning are userland.** A cron is a `croner` instance in `app.ts`; a webhook is manual provider console work guided by a blueprint. The framework describes the delivery boundary but takes no responsibility for the wire's existence.

---

## 4. Insights for Alchemy

1. **Flue independently converged on "the log is the single representation" — and shipped the detail Alchemy hasn't specified yet: delta-granularity journaling with idempotent record identities.** Flue journals every text/thinking delta and derives tool-outcome record ids deterministically from `(assistantMessageId, toolCallId)` (`session.ts:871-872`) so replays collide instead of duplicating. → For the Phase 2 Trace schema (design §2.3), specify record identity rules *now*: every KernelEvent that durability depends on needs a deterministic id derivable from `(term, session, turn, callId)`, not a UUID minted at emit time. That's what makes `Checkpoint`/replay idempotent in the step machine (§2.4).

2. **Their recovery classification is a ready-made spec for our `Recovered` feedback.** Flue's classify-then-repair states — `completed | advanced_past_input | resume(partial assistant) | tool_results_partial | tool_use_unresolved | terminal_error` (`session.ts:3233-3296`) — enumerate exactly what a Ring DO must decide after eviction. Alchemy's step machine gets `Feedback = Recovered` (design §2.4) but doesn't yet define what Recovered *carries*. Adopt their doctrine verbatim: reuse durable partials, repair unresolved tool calls with explicit interrupted-error results (never re-execute), re-dispatch the model at most once when nothing persisted. Also adopt their terminal guarantee: whatever settles a run must leave zero unpaired tool calls in the Trace — this is the tool-pairing invariant extended to *abandonment*, not just trimming.

3. **Two-plane state (mutable coordination vs. append-only truth) should be explicit in the Cloudflare harness.** Flue cleanly separates submission claims/leases/attempt-markers (operational, mutable) from canonical records ("not a second transcript", `durable-execution.md:23`). Alchemy's design says "fold + Trace in DO storage" but hasn't named the work-coordination plane. The Ring DO needs both: the Trace (plane 2) and a WorkQueue/admission ledger (plane 1 — design §3.2's `WorkQueue` seam). Steal: idempotent admission keyed by an external delivery id (GitHub deliveryId!), per-ring FIFO runnable-head, attempt markers with staleness cutoff, and *advisory* leases on DOs (single-threaded) vs real leases on any future Node/AWS harness.

4. **Flue validates using Think's fiber API as a wake-signal only — supporting Alchemy's plan to own the journal.** Flue calls `runFiber`/`stash`/`onFiberRecovered` (the `agents` SDK / Project Think surface, `agent-coordinator.ts:60-70`) but stashes just `{ submissionId, attemptId }` and treats recovery as "request recovery + reconcile from my own store" (`agent-coordinator.ts:280-293`). The real checkpoint is their own canonical stream. This is exactly design §3.2's stance ("ours remains the default because the journal must be our Trace format") — Flue is evidence that using the platform's fiber recovery *as a trigger* while owning the state format is workable in production. Also steal the belt-and-suspenders: a self-rearming `schedule()` wake (30s) so recovery never depends on the fiber callback alone.

5. **Channels: Flue is the closest existing system to `EventSource<In, Channel>` — and it stops exactly where Alchemy's design begins.** Mechanism-by-mechanism:
   | Mechanism | Flue | Alchemy design |
   |---|---|---|
   | Verification | channel package (HMAC over exact bytes, `webhook.ts:44-47`) | channel Layer (`GitHubRepositoryEventSourceLive` verifies) |
   | Typed payloads | provider-native types (`@octokit/webhooks-types`) | `EventSource.schema` |
   | Routing to consumer | *user code*: `dispatch(agent, { id: conversationKey })` | `Router` seam: source name → subscribed rings |
   | Subscription → wire | **manual**: user creates the webhook in the provider console | **provisioned**: subscribing puts the channel tag in `Req`; the Layer provisions the Webhook resource (design §1.2.3) |
   | Dedup | explicitly user's job (`channels.md:283-290`) | unspecified! |
   
   Two takeaways: (a) Alchemy's provisioning story is a genuine differentiator — Flue's blueprint-pipe-to-codex flow (`flue add channel X --print | codex`) is a confession that this step isn't automated; (b) Flue's explicit non-dedup forces every user to rediscover idempotency — Alchemy's `Router`/`WorkQueue` seam should make delivery-id dedup a harness guarantee (we have the deliveryId and the DO ledger; insight 3's idempotent admission is the mechanism).

6. **conversationKey-as-instance-id is a pattern Alchemy should name: world identity → ring-run identity.** A GitHub issue becoming the durable agent instance (`examples/github-channel`) is Flue's version of "loops couple through the world" (design §0.7) — the *world object* is the session key. In Alchemy terms: a `Fix` run's work item (`issue`) should deterministically key its Workflow instance / DO sub-state (`Fix#1234`, design §3.2 already hints at this). Make the derivation explicit in the Kernel contract: the work-item's canonical identity is the run's durable identity, which is what makes duplicate triggers collapse.

7. **Per-instance tool closure is the value-level shadow of per-agent Layers.** `defineAgent(({ id }) => ({ tools: [commentOnIssue(parseConversationKey(id))] }))` binds tool *physics* to the instance at init time. Alchemy does this one level up with per-term Layer provision (design §1.4), which is strictly stronger (typed, auditable) — but Flue exposes a *per-instance* (not just per-term) binding point. Alchemy's equivalent question: when `Fix` dispatches a run for issue #1234, which Layer scopes `OpenPullRequest` to that repo? Answer candidates: the Kernel resolves tools per-run with the work item in context. Worth a design note in §2.2 — per-run scoping is currently unstated.

8. **The `finish`/`give_up` result-tool pair is the runtime mechanism `AI.until(schema)` needs — including its failure half.** Flue derives a `finish` tool from the result schema, validation errors bounce back as tool errors for self-correction, success sets `terminate` (`result.ts:174-234`), a nag prompt fires if the model stops without calling either, and `give_up` is a **typed refusal** (`ResultUnavailableError` with reason + the assistant text). Alchemy's halt derives `Out` but has no vocabulary for "the loop concludes it cannot produce `Out`". That's not `BudgetExceeded` (nothing ran out) — it's a distinct `Err` arm. Recommend: kernel-level `give_up` semantics producing a typed `Refused`/`Unachievable` error in the loop's `Err` channel, and the bounce-invalid-results-back-as-feedback trick for schema'd halts. (Contradiction flag: design §1.2.2 currently types `Err` as only `BudgetExceeded`; §8.4's "escalation vocabulary remains undesigned" is where this lands.)

9. **Compaction-as-Trace-record, projection-as-context validates fold-in-the-Trace — but Flue shows the *minimum viable* fold and its ceiling.** Their compaction record (`summary`, `firstKeptEntryId`) is a fold snapshot stored in the log, and context = projection through the latest fold — structurally identical to design §8.4's "fold snapshots reference the trace events that motivated them" (they store `sourceLeafId`, a provenance pointer!). But it's the only strategy, unswappable, and there's no cross-instance or externalized memory at all. This validates Alchemy's ContextPolicy-as-seam inversion (§2.6): Flue users wanting OM or Ralph semantics simply can't. Also worth copying: model-aware default thresholds (`deriveCompactionDefaults` clamping against tiny windows, `compaction.ts:51-72`) and folding the fold's own token cost into the triggering run's budget accounting (`session.ts:2863-2868`) — budget accounting must include fold/judge costs (design §8.4 flagged "judging itself has a budget"; same for folding).

10. **Subagent recovery inside the parent's envelope is a design answer Alchemy should copy for `ForkLoop`.** Flue: child conversations are durably parent-linked via `parentToolCallId` (the "durable join key", `session.ts:281-297`); recovery reattaches in-flight children and resolves the parent's pending tool call from the resumed result; children have **no independent durability config**; parent-budget exhaustion settles the child's call as interrupted *with a link to the retained child transcript* (`durable-execution.md:70-78`). Map to Alchemy: a `ForkLoop` command's child ring must be joined to the parent's Trace by the forking event's id; parent `Scope` death must settle the fork as a typed interruption while retaining the child Trace for observation. This is Effect's fiber tree made durable — the design (§2.5 "authority flows down") assumes it; Flue shows the persistence schema for it.

11. **Deploy-target strategy: Flue's "one runtime interface, N coordinators" is Kernel-implementations-as-Layers minus the types — and their honesty about Node is a warning.** Flue ships two coordinators (CF DO vs Node process) behind one store contract, then documents that Node fundamentally can't self-wake and needs single-owner routing (`durable-execution.md:45-59`). For Alchemy: the conformance suite (design §2.6) should include *liveness* cases (who wakes the ring after the host dies?) that a harness may honestly fail, with the failure surfaced as a documented capability flag on the harness Layer rather than a silent behavioral difference. Also adopt their contract-test-suite-for-adapters pattern (`defineStoreContractTests` exported from test-utils) for any seam Alchemy expects third parties to implement (Durability, TraceStore).

12. **`kind: 'user'` vs `kind: 'signal'` is a vocabulary distinction Alchemy's EventSource should preserve.** Flue's insight: most channel events are *not* a user talking to the agent — they're world activity the agent observes as one participant, with sender identity as metadata, rendered in a distinct (XML-enveloped, injection-validated) envelope (`channels.md:216-226`). Alchemy's triggers deliver typed `In` payloads, so the type system already distinguishes — but the *renderer* (design §1.6) should render trigger stimuli distinctly from user turns, and the injection concern (validated envelope tag) applies verbatim to rendering world events into prompts.

13. **What Flue's gaps confirm about Alchemy's bets.** No judge, no budgets-beyond-retries, no HITL, no perpetual-loop vocabulary, no provisioning — every one of these is a top-level term in Alchemy's design (`AI.check`, `AI.budget`, human-class tools as Layers, `AI.never` + health signals, EventSource-provisions-the-wire). Flue is strong evidence that the industry's newest well-engineered harness stops at exactly the layer Alchemy starts, i.e. the designs are complementary rather than competitive: a `FlueKernel` wrapping Flue's Session/submission machinery as a Kernel Layer is even conceivable (their durable substrate is the part worth wrapping; their config surface is the churny part to hide behind terms).

### Contradiction flags against alchemy-ai-design.md

- **§1.2.2 `Err` derivation**: Flue's `give_up` shows a needed error arm (`Refused`) that isn't `BudgetExceeded` — currently unrepresentable (insight 8).
- **§2.4 `Feedback.Recovered`**: underspecified relative to what recovery actually requires; Flue's classification enumerates the states (insight 2).
- **§3.2 durability table** presumes CF Workflows for iteration-scale durability; note Flue deliberately does **not** use CF Workflows anywhere — they built submissions + fibers on DOs instead, and punted workflow durability. Worth a Phase 0 check on whether CF Workflows' replay constraints fight the Trace-as-journal design where Flue's DO-only approach didn't.
- **§0.4 "kernel has no component vocabulary"**: Flue is the counterexample-by-contrast — `AgentProfile` hardcodes `compaction`, `durability`, `sandbox`, `subagents` as top-level config fields (`agent-definition.ts:25-43`), and each has already churned across betas. Their churn is empirical support for keeping those words out of the Kernel interface: Flue can't change compaction semantics without a breaking config change; Alchemy would swap a Layer.

### Honesty notes

- I did not run any Flue code; findings are from source + in-repo docs.
- I did not fetch flueframework.com (in-repo `apps/docs` content appears to be the same source; the durable-execution and channels pages were read from the repo at the pinned commit).
- pi-agent-core/pi-ai internals were **not** inspected (dependency not vendored; `node_modules` not installed). Claims about pi's loop are inferred from Flue's usage (`Agent`, `streamSimple`, `terminate: true`, `toolExecution: 'parallel'`, subscribe event shapes) and comments, not from pi source.
- I found no human-in-the-loop, judge, or budget primitives; stated as absences after targeted greps (`approval|human|escalat`, `finish/give_up` being the only halt machinery). Possible I missed something in `packages/dev-console` or `apps/www`, which I did not read.
