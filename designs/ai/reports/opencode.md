# OpenCode (anomalyco/opencode) — study for Alchemy AI

**Subject:** `anomalyco/opencode` @ `dev` (v1.17.15, Jul 2026), cloned shallow into `.vendor/opencode`.
**Caveat on method:** the clone is `--depth=1`, so git history/commit archaeology was not available. All v1-vs-v2 findings come from the code itself (both generations coexist in the repo), the `specs/` directory (their design docs, including a candid `specs/v2/todo.md` with per-person assignments), `CONTEXT.md` (their ubiquitous-language document), and `specs/v2/schema-changelog.md` (dated decisions with "Reason" sections). Where I could not determine something, I say so. Note the repo moved orgs (SST → anomalyco); our design doc §0.1 cites "OpenCode (SST)".

---

## 1. Architecture overview

OpenCode is a coding agent with a client/server split: an Effect-based server core, a generated SDK, and many frontends (TUI, desktop, web, VS Code, GitHub app, Slack). It is **mid-rewrite**. The repo contains two complete generations:

| | **V1 (shipped product)** | **V2 (the redesign, in `packages/core`)** |
|---|---|---|
| Loop | `packages/opencode/src/session/prompt.ts` — a 1,631-line monolith (`SessionPrompt`), plus `processor.ts` (718 lines) | `packages/core/src/session/runner/llm.ts` (432 lines) + `run-coordinator.ts` (104) + `input.ts` (288) — small orchestration over collaborators |
| State | JSON files → ad-hoc SQLite wrapper (`storage/db.ts`, now deleted per `specs/storage/remove-opencode-db.md`) | **Event sourcing**: durable per-session event log in SQLite (drizzle), projectors, replay, read models |
| Events | `GlobalBus` = a Node `EventEmitter` with `payload: any` (`packages/opencode/src/bus/global.ts:1-22`) | `EventV2` — typed, versioned, durable event bus with per-aggregate sequences, transactional projection, replay + owner fencing (`packages/core/src/event.ts`) |
| Model layer | Vercel AI SDK (`import { tool, jsonSchema } from "ai"` in `prompt.ts:13`) | **Own LLM package** `@opencode-ai/llm`: protocol adapters (anthropic-messages, openai-chat/completions/responses, bedrock, gemini), routes, auth, framing; AI SDK survives only as one endpoint type |
| HTTP | Hono + Zod | Effect `HttpApi` (`packages/protocol` → `packages/server`), generated Promise+Effect clients, in-memory embedded mode (`packages/sdk-next`) |
| Schemas | Zod | Effect `Schema` everywhere (branded IDs, `Schema.TaggedErrorClass`, schema-defined events) |
| DI | Effect Layers, ad hoc | Effect Layers **plus a home-grown `LayerNode` graph** with scope tags (`global` vs `location`), dependency checking, hoisting, replacement (`packages/core/src/effect/layer-node.ts`) |

The one-line verdict from their own `specs/v2/todo.md:3`: *"ok we need to work towards a launch of v2 so we can get out of this rebuild phase."* The V2 runner is explicitly built *"without bridging through legacy `SessionPrompt.loop(...)`"* and the V2 runner header warns: *"Keep this as orchestration over smaller collaborators rather than rebuilding the legacy `SessionPrompt` monolith"* (`packages/core/src/session/runner/llm.ts:46-48`).

**Direction of the Effect bet:** V2 did not abandon Effect — it went dramatically deeper. Everything is a `Context.Service`; they built `effect-drizzle-sqlite`, `httpapi-codegen`, `codemode` ("Effect-native confined code execution over schema-described tools"), and use `FiberSet`, `PubSub`, `Deferred`, `Semaphore`, `Scope` as core mechanics. The one place raw Effect wasn't enough — layer scoping — they built on top of it rather than around it (see §7 below).

Package map (v2-relevant):

```
packages/core          — the v2 engine: session/, event.ts, tool/, system-context/, permission.ts, effect/ (LayerNode)
packages/schema        — pure Effect Schema types incl. event definitions (event.ts: define/durable/versionedType)
packages/llm           — provider abstraction: route/, protocols/, providers/, tool-runtime
packages/protocol      — the authoritative HttpApi definition
packages/server        — HttpApi handlers over core
packages/client        — generated Promise + Effect network clients
packages/sdk-next      — embedded OpenCode: runs the server router in-memory, no sockets
packages/opencode      — the v1 app (CLI/server), progressively hollowed out into core
specs/v2/              — session.md, tools.md, provider-model.md, config.md, todo.md, schema-changelog.md
CONTEXT.md             — the v2 ubiquitous language ("Session Drain", "Context Epoch", "Safe Provider-Turn Boundary"…)
```

---

## 2. Per-topic findings

### 2.1 The loop

**V1**: `SessionPrompt` (`packages/opencode/src/session/prompt.ts`, 1,631 lines) does everything — prompt assembly, tool wiring, plugin transforms, MCP, LSP, retries, structured output, compaction triggers — with `SessionProcessor` (`processor.ts`) handling one stream. It grew a `DOOM_LOOP_THRESHOLD = 3` constant (`processor.ts:30`) — detection of the agent repeating the same tool call — a stagnation detector bolted onto the loop.

**V2**: the loop is three nested `while`s in ~20 lines (`packages/core/src/session/runner/llm.ts:383-406`):

```ts
while (shouldRun) {            // drain: keep going while queued inputs exist
  let needsContinuation = true
  let step = 1
  while (needsContinuation) {  // provider turns
    const result = yield* runTurn(input.sessionID, promotion, step)
    needsContinuation = result.needsContinuation
    step = result.step + 1
    promotion = "steer"
    if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
  }
  shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
  promotion = shouldRun ? "queue" : undefined
}
```

Key vocabulary (CONTEXT.md): a **Provider Turn** is one `llm.stream(request)`; a **Session Drain** is *"one process-local execution span … A Session Drain has no durable identity or transcript boundary."* Exit conditions: continuation ends when the provider returns no tool calls (`needsContinuation` is only set on `tool-call` events, `llm.ts:248`), when the agent's configured step limit is hit (last step sends `MAX_STEPS_PROMPT` with `toolChoice: "none"`, `llm.ts:202-213`), or when the user declines a permission (declining is a *defect* that halts the drain, not tool output — `llm.ts:144-150`). Iteration is driven by a durable inbox, not by callers: `run` (explicit resume, joins active execution) vs `wake` (advisory, coalescing) on a process-global `SessionRunCoordinator` that serializes per-session and is concurrent across sessions (`run-coordinator.ts:5-15`).

There is **no reified turn object and no reified run object**. This is deliberate and repeated: *"Durable recovery must reason from prompts, projected history, provider attempts, and tool state rather than inventing an enclosing execution identity"* (CONTEXT.md; also `specs/v2/todo.md` "Deferred durable continuation recovery").

**Compaction as control flow**: mid-turn transitions (auto-compaction, overflow-compaction) are implemented as **typed defects** (`TurnTransitionError`) thrown through the stream stack and caught by `Effect.catchDefect` wrappers that re-enter `runTurn` (`llm.ts:152-166, 355-381`) — an interesting, slightly smelly pattern acknowledging that "restart this turn from rebuilt history" doesn't fit a linear effect pipeline.

### 2.2 Memory & compaction

The unit of memory is the **Context Epoch** + **compaction checkpoint**, and it is the closest thing in the wild to our fold — with one big difference: the durable substrate is the *full event log*; the compaction summary is a *projection* of it, not the only survivor.

- Before each provider turn, the runner estimates the full request and compares against `context − max(outputAllowance, buffer 20k)` (`compaction.ts:225-236`). If over, it compacts *before* executing the pending turn.
- Compaction streams a summary request with a **fixed structured Markdown template** — Objective / Important Details / Work State (Completed, Active, Blocked) / Next Move / Relevant Files (`compaction.ts:16-46`) — plus token-bounded serialized recent context. Repeated compactions **update the previous summary** rather than starting over (`buildPrompt`, `compaction.ts:161-168`).
- Durability discipline: `compaction.started` is durable; deltas are live-only; only `compaction.ended` (carrying summary + recent text) projects a model-visible compaction message. *"A failed or interrupted attempt therefore leaves the previous history boundary active"* (`specs/v2/session.md:117`). *"Compaction keeps the full transcript durable while replacing its active model representation"* — memory changes are non-destructive projections.
- **Provider-native content never crosses the boundary**: *"Provider-native assistant, reasoning, and tool messages never survive across the boundary, avoiding signature and encrypted-reasoning failures when the earlier prefix changes"* (`specs/v2/session.md:115`). Serialized plain text only.
- **Overflow recovery**: when the provider rejects with context overflow *before any durable output*, one overflow-triggered compaction rebuilds the same logical turn with exactly one retry; a second overflow is a terminal failure. *"Recovery never loops or replays partial side effects"* (`specs/v2/session.md:121`).
- The **System Context** (their name for the system prompt, deliberately avoiding that term) is composed of typed **Context Sources**: `{ key, codec, load, baseline(current), update(prev, current), removed?(prev) }` (`packages/core/src/system-context/index.ts:32-39`). A **Context Epoch** stores one immutable baseline (the provider-cache anchor) plus a model-hidden JSON snapshot; changed sources are admitted as **chronological system messages** at the next **Safe Provider-Turn Boundary** rather than by mutating the baseline (`context-epoch.ts:40-78`). Sources can return `unavailable` → stale-while-revalidate; an unavailable *initial* baseline blocks the first turn rather than persisting an incomplete one.
- Prompt-cache respect is explicit: `promptCacheKey` derived from session ID (`llm.ts:204`); epoch = "immutable provider-cache baseline" (CONTEXT.md).

### 2.3 Tool system

V2 tools (`specs/v2/tools.md`, `packages/core/src/tool/tool.ts:71-132`):

- `Tool.make({ description, input, output, execute, toModelOutput?, structured?/toStructuredOutput? })` returns an **opaque frozen object**; schemas and executor live in a module-private `WeakMap` (`tool.ts:69`). Nothing can introspect or re-execute a tool except the registry. *"Input and output codecs are self-contained. Schema conversion cannot require services. Tool dependencies are acquired during construction and captured by `execute`"* (`specs/v2/tools.md:33`).
- Tools have **no intrinsic name**; the registration record key is the model-facing name (`tools.register({ read, write, grep })`), and names are validated against a conservative provider-neutral grammar (`tool.ts:134-137`).
- **Scoped registration with overlay semantics**: latest registration for a name wins; closing a `Scope` removes exactly that registration and reveals the previous overlay (`registry.ts:85-105`). **Stale-call rejection**: turn materialization captures each advertised registration's identity object; if a settled call's registration was replaced/removed since being advertised, it settles as `"Stale tool call"` without executing (`registry.ts:50-61`, law list in `specs/v2/tools.md:173-180`).
- The settle pipeline: decode input (invalid input never invokes the tool) → execute with a **runner-supplied invocation context** `{ sessionID, agent, assistantMessageID, toolCallID }` — no domain services in context — → encode output (invalid output never settles as success) → project model-facing content → **generic output bounding** (`registry.ts:62-82`).
- **Output bounding is a settlement-boundary concern, not a tool concern**: oversized model-facing text is retained in a **Managed Tool Output File** and replaced with a bounded preview; the durable replayable record is the bounded output, not the file; if retention fails, settlement fails operationally rather than "publishing lossy success" (CONTEXT.md; `specs/v2/tools.md:153-159`).
- Failure taxonomy is razor sharp: `ToolFailure` = expected model-visible failure; **interruption is never a tool result**; defects follow operational policy; unknown/invalid/stale calls are settlement errors without invoking a handler (`specs/v2/tools.md:161-171`). *"Broad cause-catching around an executor is invalid because it consumes interruption and defects."*
- Permission checks are **inside trusted tools, not injected by the registry**: built-ins capture `PermissionV2.Service` at construction and call `permission.assert(...)` themselves (`specs/v2/tools.md:94-133`). *"Sharing a tool type does not imply equal authority."*

### 2.4 Subagents

**V2 has not rebuilt subagents yet.** `specs/v2/todo.md`: *"New Data Mode — Dax: This is mostly done. I'm working through modeling subagents, skill invocations and shell commands"*; BackgroundJob-integrated "background agent dispatch" is listed as a next slice. So the production design is V1's `TaskTool` (`packages/opencode/src/tool/task.ts`):

- A subagent is **a child session** (`sessions.create({ parentID, agent, permission })`, `task.ts:142-158`) — same machinery, different session row. Context isolation is free: new session = new history.
- **Permission derivation**: child permissions = `deriveSubagentSessionPermission({ parentSessionPermission, subagent })` plus explicit denies — subagents are denied `todowrite` and (crucially) the `task` tool itself unless their agent definition grants it, preventing uncontrolled recursive spawning (`task.ts:125-141`).
- **Model-per-role**: the subagent runs the agent definition's model if set, else inherits the parent assistant message's model/provider (`task.ts:167-170`).
- **Results return as text**: the last text part of the child session's final assistant message (`task.ts:199`). For background tasks, completion is **injected into the parent as a synthetic user prompt** (`inject`, `task.ts:202-229`) — re-entering through the same inbox as human input.
- **Resume**: passing a `task_id` reuses the child session — subagents are resumable conversations, not one-shot calls (`task.ts:47-50, 121-123`).
- Lifecycle: foreground waits with `Effect.raceFirst(wait, waitForPromotion)`; interruption cancels the child via `acquireUseRelease` + abort listener (`task.ts:296-333`).
- `sessions.active()` deliberately excludes subagents: *"background subagents and tasks do not make their parent Session active"* (CONTEXT.md).

### 2.5 Sessions / state / durability

This is V2's core innovation and the richest signal for us.

- **Event sourcing over SQLite**: every durable fact is an event with `{ id: evt_*, type, durable: { aggregateID, seq, version }, data }` defined by `Event.define({ type, durable: { version, aggregate }, schema })` (`packages/schema/src/event.ts:42-69`). Events are versioned at the type level (`session.next.step.ended.2` — version bumped when payload changed because "provider-local call identifiers can repeat across turns", `schema-changelog.md`).
- **Projection is transactional with the append**: registered projectors run *inside the same SQLite transaction* that assigns the sequence and inserts the event; post-commit, live subscribers are notified (`event.ts:236-363`). `publish(definition, data, { commit })` lets a caller atomically piggyback local state on an event commit — e.g. the Context Epoch snapshot advances atomically with its system-message event (`context-epoch.ts:72-76`).
- **Replay with fencing**: `replay/replayAll` verify sequence continuity, detect divergence (*"Replay diverged at aggregate … sequence …"*), and enforce **owner claims** (`ownerID` on the sequence row; strict-owner mismatches die) (`event.ts:441-512, 254-301`). Event replay ownership is explicitly distinct from future clustered execution ownership (`specs/v2/session.md:185`).
- **Durable tail**: `events.durable({ aggregateID, after })` replays history then tails live commits using an **edge-triggered sliding-capacity-1 dirty signal per aggregate** — wakes carry no data; the tail re-queries SQLite, so *"durable rows, not in-memory notifications, preserve every event and sequence"*; subscribe-before-replay closes the handoff race (`event.ts:565-604`; `specs/v2/session.md:183`).
- **The inbox**: prompts are **admitted** (durable `session_input` row via `PromptAdmitted` event, idempotent by message ID — exact retry returns the same receipt, conflicting reuse dies, `input.ts:41-81`) and later **promoted** (`Prompted` event whose projector atomically writes the visible user message and marks the inbox row, `input.ts:118-168`). Delivery is `steer` (promotes at next safe boundary mid-drain) vs `queue` (FIFO, one at a time when the session would otherwise go idle).
- **Crash recovery is deliberately deferred and explicitly reasoned**: before assembling a request, the runner durably fails any tool still projected `running` from a previous process with "Tool execution interrupted" — *"abandoned side effects are never silently replayed"* (`specs/v2/session.md:50`; `llm.ts:119-139`). A wake *"does not infer that ambiguous provider work is safe to retry"*; recovery must model *"provider-dispatch ambiguity, required continuation, … retry policy, and visible recovery status together"* and *"must not assume an enclosing durable execution identity"* (`specs/v2/session.md:165`).
- Interruption was **made process-local** — they *removed* a durable `session.next.interrupt.requested.1` event they had shipped (`schema-changelog.md` 2026-06-22).
- Client/server split: the authoritative `HttpApi` lives in `packages/protocol`; `packages/server` implements handlers; `packages/client` is generated (Promise + Effect variants with isolated exports so the Promise root has "no runtime path to Effect"); `packages/sdk-next` is **Embedded OpenCode** — it executes the server's assembled `HttpRouter` **in memory** through a fake `fetch`, *"opens no listener and performs no network I/O, while preserving Server routing, middleware, codecs, handlers, and errors"* (`sdk-next/src/opencode.ts:10-43`; CONTEXT.md).

### 2.6 Async vs sync

- Two public streams with **deliberately different contracts** (CONTEXT.md): `events.subscribe()` = instance-wide, live-only, no replay, includes heartbeat/lifecycle, consumers recover by refreshing authoritative state; `sessions.events({ sessionID, after })` = durable-only replay-and-tail with one cursor == one persisted sequence. *"A Session ID is not an optional filter on `events.subscribe()`"* — they refuse to blur the two.
- **Streaming deltas (text/reasoning/tool-input fragments) are live-only and never durable**: *"they cannot advance the durable cursor, replay after reconnect, or be mistaken for publication boundaries"* (`specs/v2/session.md:175-177`; `schema-changelog.md` "Stop synchronizing text deltas… keep them explicitly ephemeral"). Reason given: *"Fragment streams are useful to connected renderers but must not advance durable cursors or inflate synchronized storage."*
- Neither stream auto-reconnects; resume composition (retain last seq, reopen with `after`) is explicitly left to callers.
- Inside a turn, tool execution is **eagerly parallel** via `FiberSet`: each complete tool call is durably projected, then its execution forks immediately; after the provider stream closes the runner awaits all settlements, then reloads projected history **once** before continuing (`llm.ts:249-271, 296`). Eager execution is "intentionally unbounded" in the local slice because SQLite publication is serialized per turn anyway (`specs/v2/session.md:173`).
- Publication itself is serialized with a one-permit semaphore (`withPublication`, `llm.ts:228-230`).

### 2.7 Pluggability & Effect usage

- **LayerNode** (`packages/core/src/effect/layer-node.ts`) is the big Effect-architecture innovation: an explicit dependency-graph DSL *above* `Layer`. Nodes carry `{ service, implementation: Layer, dependencies, tag }` where tags define **scope strata** — `tags({ location: ["global"], global: [] })` means location-scoped nodes may depend on global nodes but not vice versa (`app-node.ts:3-12`). `hoist` extracts all nodes of a tag into a shared group (so one process-global `Database` serves many per-location graphs); `compile` walks the graph into `Layer.provide` chains with cycle detection and type-checked replacements (`layer-node.ts:211-272`). Every service module exports `node = makeGlobalNode(...)` or `makeLocationNode(...)` with explicit `deps: [...]`. This exists because raw Layer memoization couldn't express "same service, different cache lifetime per scope" plus test-time surgical replacement.
- Plugins: ordered, **replayable config transforms** over immer-style `Draft`s (`specs/v2/provider-model.md:286-358`, `catalog-config-plugin-lifecycle.md`) — because *"a transform can mutate any part of config, a transform change cannot safely trigger only `Catalog.reload()`… Every service derived from config must reload in place."* Plugins receive **narrow capabilities**, not internals: *"A Location plugin receives only the narrow `Tools` registration capability, not the internal registry"* (`specs/v2/tools.md:81`). Providers themselves are plugins that register models into the catalog.
- Aspiration (`specs/v2/todo.md`): *"Everything is hotreloadable… every service should emit granular events so services can react… also prevents startup from blocking."*
- `packages/codemode` — Effect-native confined code execution over schema-described tools (agent writes code that calls tools instead of one-call-at-a-time) — exists as a separate package; not yet integrated into the v2 runner as far as I can tell.

### 2.8 Human-in-the-loop

- **PermissionV2** (`packages/core/src/permission.ts`): rules are `{ action, resource, effect: allow | deny | ask }`, evaluated by `findLast` wildcard match with default `ask` (`permission.ts:76-86`). `assert` either passes, dies pending on a `Deferred` until a human replies, or fails typed. Three human outcomes: allow; **`DeclinedError`** (halts the drain — matching V1: *"declining a user prompt halts the loop instead of becoming model-facing tool output"*, `llm.ts:144-150`); and — notably — **`CorrectedError { feedback: string }`** (`permission.ts:62-64`): the human can answer a permission prompt with *corrective instructions* that flow back as typed feedback. Approvals can be saved (`save` patterns → `PermissionSaved`, project-scoped).
- **QuestionV2** (`packages/core/src/question.ts`): a first-class ask-the-human service — typed questions with option lists, `ask` returns answers or `RejectedError`; surfaced as a `question` tool (`packages/core/src/tool/question.ts`). Human interaction is an ordinary tool + service pair, exactly our "autonomy is a Layer choice" claim.
- **Steering**: mid-run human input is not an interrupt — it's a durable `steer` inbox row promoted at the next safe provider-turn boundary; promotion resets the agent's step allowance (`specs/v2/session.md:50, 155-158`).

### 2.9 Provider abstraction

- `@opencode-ai/llm` separates **protocol** (wire dialect: `protocols/anthropic-messages.ts`, `openai-responses.ts`, `openai-chat.ts`, `bedrock-*.ts`, `gemini.ts`) from **route** (endpoint + auth + transport + framing: `route/`) from **provider** (vendor config: `providers/`). `LLMClient.Service` exposes `stream`/`generate`; streaming is `Stream.paginateChunkEffect`-style with typed `LLMEvent`s and terminal detection (`route/client.ts:279-293`).
- The **catalog** (`specs/v2/provider-model.md`) is data: `ProviderV2.Info { id, enabled: false | via-env | via-account | via-custom, endpoint, options }`; `ModelV2.Info` includes capabilities, cost tiers, limits, **variants** (per-model option overlays), release dates, status. Endpoint union includes `{ type: "unknown" }` resolved lazily from the provider.
- **No silent fallback** is a design rule: unsupported routes fail with `UnsupportedEndpointError`; *"`openai/responses` with WebSocket transport must not silently downgrade to HTTP"* (`provider-model.md:284`).
- Model-switch hygiene: provider-native reasoning/metadata replay **only while the historical assistant model matches the continuation model**; after a switch, reasoning becomes plain text and native metadata is omitted (`specs/v2/session.md:52`).
- `structuredOutput`/`generateObject` is implemented uniformly by forcing a synthetic tool call — *"provider-native JSON modes are intentionally avoided so behaviour is uniform"* (`llm/src/llm.ts:146-149`).
- `packages/http-recorder` records provider HTTP for deterministic tests.

### 2.10 Integration surfaces

- **LSP as environment feedback** (v1, still the shipped behavior): after an edit, the edit tool touches the file, pulls diagnostics, and appends `"LSP errors detected in this file, please fix:"` to the tool output (`packages/opencode/src/tool/edit.ts:197-202`). V2 has not rebuilt it: `// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists` (`packages/core/src/tool/edit.ts:88`).
- Server mode: one instance hosts many projects/worktrees ("Location" = directory + optional workspace; per-location service graphs via LayerNode; `specs/project.md`). PTY service with host-supplied environment overlay. mDNS discovery, auth middleware.
- Frontends: TUI (own package + specs), desktop, web, VS Code; `github/` (GitHub app integration), `packages/slack`. All consume the same HttpApi/SSE; the desktop/web use the generated clients; embedded consumers use sdk-next in-process.

---

## 3. Judgments

**What V1 got wrong (as evidenced by what V2 changed):**

1. **The monolithic loop.** 1,631-line `SessionPrompt` mixing prompt assembly, tools, plugins, retries, compaction. The V2 runner's header comment is a standing instruction not to rebuild it. The rewrite decomposes into inbox / coordinator / turn / registry / compaction / epoch, each ~100-450 lines.
2. **Untyped, non-durable events.** V1's `GlobalBus` is an `EventEmitter` with `payload: any` that patches IDs onto payloads at emit time (`bus/global.ts:14-19`). V2 makes every event schema-defined, versioned, durable, sequenced, and replayable — and makes *the event log the source of truth* with projections derived from it.
3. **Mutable system prompts killing prompt cache.** V2's Context Epoch + chronological mid-conversation system messages exist precisely to keep the baseline immutable for provider caching while still admitting context changes.
4. **Storage as an ambient singleton.** The `storage/db.ts` wrapper (ambient transaction context, post-commit effect queues) was killed in a documented five-group migration (`specs/storage/remove-opencode-db.md`) with invariants called out ("post-commit publish effects must not run before the transaction commits").
5. **AI SDK dependence.** V2 wrote its own protocol adapters; the AI SDK remains only as one endpoint type. The specs' concern with native continuation metadata, reasoning signatures, exact structured round-trips, and no-silent-downgrade explains why: they needed provider-semantic control the SDK abstracted away.
6. **Hono/Zod duplication.** Replaced with a single authoritative Effect HttpApi from which clients, SDK IR, and embedded mode are all derived.

**What they got right (and kept):**

- Client/server split with SSE; subagents as child sessions; permission gates; LSP-diagnostics-as-tool-output; the TUI-first product.
- In V2: the failure taxonomy (expected failure ≠ interruption ≠ defect), idempotent admission receipts, transactional projection, cache-conscious context management, scoped tool registration with stale rejection, and the discipline of writing the ubiquitous language down (CONTEXT.md) before code.

**Where they are candidly unfinished:** post-crash continuation recovery (deferred with a written rationale), subagents in V2, V2 LSP runtime, plugin hooks for V2, provider timeout/retry policy (*"intentionally deferred… rather than hardcoding one default for every provider"*, `specs/v2/session.md:153`), clustered execution ownership.

---

## 4. Insights for Alchemy — numbered, observation → implication

1. **Their EventV2 is our Trace, independently converged — copy its commit discipline.** Observation: v2's single durable representation is a per-aggregate, sequence-numbered, schema-versioned event log; *projectors run inside the append transaction*; live notification happens only post-commit; an optional `commit(seq)` hook lets adjacent state advance atomically with an event (`event.ts:236-363`, `context-epoch.ts:72-76`). → Implication: our `KernelEvent` Trace (design §2.3) should adopt (a) **per-ring aggregate sequences** as the only cursor, (b) **versioned event types** (`versionedType(type, version)`) from day one — they had to reset beta history twice for unversioned payloads (`schema-changelog.md` 2026-06-22 entries), and (c) fold-snapshot writes that commit **atomically with the events that motivated them** — which also gives us the provenance link §8.4 asks for ("fold snapshots reference the trace events that motivated them") for free.

2. **Ephemeral deltas must never enter the Trace.** Observation: v2 explicitly stopped persisting text/reasoning/tool-input deltas; they are live-only, cannot advance cursors, and cannot replay (`schema-changelog.md`; `specs/v2/session.md:175-177`). → Implication: our `ModelDelta` KernelEvent (design §2.3) should be marked **non-durable by type** — two event classes (durable vs live) in the core vocabulary, so a `TraceStore` cannot accidentally persist deltas and folds cannot depend on them. Otherwise trace volume (§6 risk) explodes and replay contracts blur.

3. **The durable-tail wake pattern is the right physics for the Ring DO.** Observation: v2's replay-and-tail uses an edge-triggered sliding-1 wake per aggregate; the wake carries no payload — the reader re-queries the log, so missed wakes are harmless and the handoff race is closed by subscribing before replay (`event.ts:565-604`). → Implication: implement `Cloudflare.AI.TraceStore` tailing (and parent-watches-child `AI.on(KernelEvent)` triggers) exactly this way over DO SQLite + alarms/RPC: **rows are truth, wakes are hints**. This is also the correct wake-vs-run split for the Ring reducer: our `stimulus` should coalesce like their `SessionRunCoordinator.wake` (pendingWake flag, successor drain — `run-coordinator.ts:51-92`).

4. **A durable admission inbox should sit between triggers and loop bodies.** Observation: prompts are *admitted* (durable, idempotent receipt keyed by caller-supplied ID; exact retry returns the same receipt; conflicting reuse fails) and separately *promoted* into model-visible history at a safe boundary; `steer` and `queue` are distinct delivery modes with distinct promotion rules (`input.ts:41-81, 245-288`; `specs/v2/session.md:155-171`). → Implication: our `AI.each` work queue and `AI.on` event delivery in the Cloudflare harness need precisely this two-phase shape (Queues → DO dedupe/ack ledger is already sketched in design §3, but the **idempotent admission receipt** and **steer-vs-queue distinction** are missing vocabulary). Steering also gives us a principled story for "human message arrives mid-run" that isn't interruption: promote at the iteration boundary, reset the step budget.

5. **OpenCode's durability model contradicts §2.4's replay-based durability — take the contradiction seriously.** Observation: v2 does **not** journal commands and deterministically replay a pure step function. It persists *facts* (events), makes projectors idempotent, and on resume **fails** any tool left `running` ("Tool execution interrupted") rather than re-running it; it refuses to create a durable execution identity, and defers ambiguous-provider-dispatch recovery entirely, with a written argument (`specs/v2/session.md:50, 165`; `llm.ts:119-139`). Their reason: after a crash you cannot know whether the provider call or tool side effect happened, so "replay" of non-deterministic, non-idempotent commands is unsafe; *"abandoned side effects are never silently replayed."* → Implication for design §2.4 and §3's `Durability` seam: keep the pure `step` machine (it buys testability and model-free simulation regardless), but do **not** make write-ahead command journaling + replay the default recovery semantics for turns. The default `Resume` policy on the Ring DO should be OpenCode-shaped: mark in-flight `CallTool`/`CallModel` commands as interrupted-failed, deliver the last checkpoint (fold) to the policy, and require explicit `Continue | Retry | Terminal` decisions — which our design already types (`Resume` in §3) but currently treats as the exotic path rather than the default. Deterministic replay remains sound *between* checkpoints only where every effect is an Activity with recorded results (Workflow granularity), i.e. our `Durability.workflow` rung — not the doFiber rung.

6. **"Session Drain has no durable identity" endorses run-scoped `Out` but warns against reifying runs.** Observation: v2 deliberately has no durable "run" entity; recovery reasons from prompts + history + tool state (CONTEXT.md). → Implication: our `LoopService.dispatch(item)` returning `Effect<Out, Err>` is fine as a *process-local* join handle (like their `Coordinator.run`), but the Ring DO's persisted state should not contain a "current run" object — it should contain the fold + trace + inbox, from which "is a run active" is derivable. This keeps crash semantics honest: a re-woken DO doesn't resurrect a run object, it re-drains eligible work.

7. **Their Context Source registry is a productized fold-input pipeline — steal the interface.** Observation: `Source<A> = { key, codec, load, baseline, update, removed? }` with unavailable-as-stale-while-revalidate, deterministic key-ordered composition, changed sources becoming *chronological messages* rather than baseline mutations, and the snapshot advancing atomically with the emitted message (`system-context/index.ts:32-39`; CONTEXT.md). → Implication: our renderer (§1.6) covers the static charter, but agents also need *dynamic* environment context (repo state, dates, skill guidance). Rather than inventing this in Phase 2 ad hoc, adopt Context-Source semantics as a **seam of the kernel implementation** (`ContextPolicy`-adjacent): baseline rendered once per epoch (cache-stable, exactly our promptHash goal), deltas admitted as dated events into the Trace — which makes context changes *visible to folds and to autoresearch* instead of being invisible prompt mutations.

8. **Compaction-as-durable-checkpoint validates the fold, with two upgrades.** Observation: compaction (a) never destroys history — it moves the *model-visible boundary* while the full log stays durable; (b) is only effective when its *completion event* commits (crash mid-compaction = previous boundary still active); (c) **updates the previous summary** instead of re-summarizing from scratch; (d) excludes provider-native content from crossing the boundary (`specs/v2/session.md:111-121`; `compaction.ts:161-224`). → Implication for our Fold (§0.8, §2.5): (i) type the fold's output as a **durable event** (`IterationFolded` carrying the folded state) so fold-effectiveness is transactional, not ambient; (ii) give the default fold agent the *previous fold output* as an explicit input (rolling update, not fresh summarization) — our `AI.fold(Scribe)` prose should be handed `(carried, trace-since-last-fold)`, which the design says but their template (Objective/Work State/Next Move/Relevant Files) is a battle-tested concrete default worth shipping as the kernel's default fold policy; (iii) the kernel must strip provider-native reasoning/tool payloads at the fold boundary — a concrete instance of our tool-pairing/trimming invariant (§2.4).

9. **Tool opacity + registration-time naming + stale-call rejection belong in our Kernel's tool seam.** Observation: v2 tools are opaque values with exactly one executor; the model-facing name is bound at registration; a call settles only against the registration that was advertised for *its* provider turn (`specs/v2/tools.md:173-180`). → Implication: when our Kernel resolves `${Tool}` refs from ambient context at interpretation time (§2.2), it should capture **registration identity per turn** so that a Layer swap (redeploy, hot reload, per-iteration re-provision) can never let an in-flight model call execute a *different* implementation than the one whose schema the model saw. This is a real hazard for us specifically, because Layer recomposition per-ring is our headline feature. Also adopt: decoded-input-or-no-execution, encoded-output-or-no-success — our ToolImpl contract should bake both in.

10. **Permission physics: `Corrected` is the missing verb in our human-tool palette.** Observation: their permission reply set is allow / decline / **correct-with-feedback** (`CorrectedError { feedback }`, `permission.ts:62-64`), and *declining halts the drain* rather than becoming tool output (`llm.ts:144-150`). → Implication: our `Approve`/`AskHuman` tool contracts (§0.9, §3 human-backed tools) should type three outcomes, not two: approved / rejected-with-reasons (feeds the next iteration, like their correction) / **halt** (escalation that stops the run rather than informing the model). Today's design sketch ("Returns approved, or rejected with reasons") misses the halt case, which OpenCode learned needs to be a *non-model-visible* control signal.

11. **Eager tool settlement with a durable record *before* side effects begin.** Observation: v2 durably records each tool call, forks execution immediately, awaits all settlements after stream close, reloads history once (`llm.ts:249-271`; `specs/v2/session.md:208-210`); settlement events carry the owning assistant message ID because provider call IDs repeat across turns (`schema-changelog.md` "Durable Step Settlement Ownership"). → Implication: our step machine's `CallTool` command should be journaled (as a Trace event, not a replay journal — see insight 5) *before* the interpreter runs it, and our Trace events need `{ ring, session, workItem }` provenance **plus a turn-scoped parent ID** — provider call IDs alone are proven insufficient as correlation keys.

12. **Two event streams, two contracts — don't let `Kernel.events` be both.** Observation: they refused to unify live firehose and durable replay into one API even though both are "the events" (CONTEXT.md: different schemas, replay guarantees, cursors, failure behavior). → Implication: our `KernelService.events: Stream<KernelEvent>` (§2.1) is currently one surface. Split it in the Kernel interface *now* (cheap at this stage): `events` (live, no replay guarantee — for dev/UI) and `trace(ring, after?)` (durable, cursor-bearing — for folds, observers, autoresearch). `AI.observe(Loop)` should be defined over the second, or observation silently loses replayability, which breaks the system loop's core promise.

13. **LayerNode is a warning about Layer-only composition at app scale.** Observation: the most Effect-fluent production team in this space found raw `Layer.provide` graphs insufficient for (a) two-tier scope lifetimes (global vs per-location caching), (b) type-checked test replacement, (c) cycle diagnostics — and built an explicit node graph with tags, hoisting, and compile (`layer-node.ts`). → Implication: our per-ring Layer graphs (§1.4, §4.2) will hit the same wall — one process (a Ring DO or dev runtime) hosts many rings sharing global services (Kernel internals, TraceStore, model clients) under per-ring tool physics. We don't need LayerNode's machinery on day one (Effect's memoMap handles sharing when references are shared), but we should (i) keep every term Layer a *named export* so replacement stays surgical, and (ii) budget for an explicit composition audit tool — their `hoist`/`hasUnbound` is what our "type-level capability audit" (no `Approve` in the closure) will want to become at runtime.

14. **The catalog/no-silent-fallback rule applies to our model seam.** Observation: model resolution fails typed (`ModelNotSelectedError`, `UnsupportedEndpointError`) rather than silently degrading; model switches drop provider-native continuation metadata deliberately (`provider-model.md:270-284`; `specs/v2/session.md:52`). → Implication: our `AiLanguageModel` requirement (§2.6) is currently a single tag. Per-ring/per-agent model selection (Judge on a cheap model, Engineer on a strong one) will need a catalog-like resolution seam; adopt their rule that *resolution failure is typed and loud*, and that **cross-model continuation strips native metadata** — a constraint our step machine's `messages` state must encode (message entries need a `model` provenance field so folds/rebuilds know what can replay natively).

15. **Steering resets the budget — a semantics we haven't specified.** Observation: promoting new user input resets the agent's provider-turn allowance; multiple steers at one boundary reset it once (`specs/v2/session.md:50`). → Implication: our `AI.budget({ iterations })` needs a documented interaction with mid-run stimuli: does a new work item / human steer reset per-iteration counters? OpenCode's answer (new human input = renewed mandate) is a sensible default for the kernel's budget accounting; ours is currently silent (§1.2.2 Budget).

16. **V1's task tool validates subagents-as-composition, and adds two features to steal.** Observation: subagents are child sessions with derived (intersected) permissions, recursion denied by default, model-per-role, results returned as distilled text, **resumable by ID**, and background completion **injected as a synthetic prompt into the parent's inbox** (`task.ts:121-158, 202-229`). → Implication: design §2.4's "sub-agents are not a Kernel feature" holds up — but (a) *resumability* (a `task_id` re-entering the same child context) is something our agent-as-tool wrapping should expose (the wrapped agent's session is addressable), and (b) background-child-completion-as-trigger confirms our "upward comms reuse the trigger vocabulary" (§2.5): their inject is exactly a KernelEvent-as-stimulus, done crudely through the prompt channel because v1 lacked typed triggers. We have the typed version; use it.

17. **Verify §0.1's OpenCode claims — mostly right, one correction.** The design doc says: Effect.Schema config ✓ (v2 even more so), Effect services for LSP ✓ (v1), `HttpApi` server ✓ (v2; v1 was Hono), "Zod/Bus event system over SSE" — **outdated**: the Zod bus is v1 legacy (`GlobalBus` is an untyped EventEmitter); v2's event system is Effect-Schema-defined, durable, and event-sourced — significantly *stronger* prior art for our Trace than the doc credits. LSP diagnostics as environment feedback ✓ (v1 only; v2 pending). Also update the attribution: the repo now lives under anomalyco, not SST.

---

## 5. What I could not determine

- **Git history**: shallow clone (single commit `0abbcdd`); I could not date the v1→v2 pivot or cite specific redesign commits/PRs. The dated `specs/v2/schema-changelog.md` (2026-06-04 → 2026-06-26) is the best available timeline; the uploaded doc dump (`opencode-1.md`) is just the GitHub README page (repo metadata: 184k stars, 832 releases, v1.17.15 on Jul 7 2026, 14,854 commits).
- **Blog posts about the rewrite**: none found in-repo; I did not fetch external sources beyond the provided dump.
- **V2 subagent design**: not yet written; only the todo note ("working through modeling subagents") and the BackgroundJob integration slice exist.
- **Whether codemode is wired into the v2 runner**: I found no imports of `@opencode-ai/codemode` from `packages/core/src/session`; it appears to be a standing capability awaiting integration.
