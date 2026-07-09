# The Serving Tier — agents over HTTP (local first, Cloudflare next)

Status: **in progress** (July 2026). Companion to `alchemy-ai-design.md`
(§2.10 points here). Updated per implementation step.

## Goal

A way to *interact* with interpreted agents — chat, watch tools run,
answer approvals, steer, interrupt — that plugs into the existing
frontend ecosystem instead of inventing a client. The same API shape
must serve from the local memory kernel today and from the Cloudflare
Ring DO later.

## Decisions

### 1. Protocol-first: speak the AI SDK v5 UI Message Stream verbatim

The [UI Message Stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
(SSE frames of typed JSON chunks, `x-vercel-ai-ui-message-stream: v1`
header, `data: [DONE]` terminator) is the lingua franca of agent UIs:

- `useChat` + `DefaultChatTransport` consume it with **zero client
  code** — the whole AI SDK UI ecosystem plugs in.
- Cloudflare's `useAgentChat`/`AIChatAgent` is the same chunk
  vocabulary carried over WebSocket; parity later is a transport swap,
  not a protocol change.
- A TUI (OpenTUI) consumes the same stream.

`src/AI/Api/Protocol.ts` is the boundary: effect Schemas for the chunk
subset the kernel emits, the `useChat` request body, and the SSE
framing. **Golden tests pin every frame byte-for-byte** — drift here
breaks other people's UIs, so the wire format is tested as a contract,
not as structure.

The Ask protocol deliberately does NOT map onto the AI SDK's native
`tool-approval-request` part: that part models *pre-execution*
approval, while an alchemy ask parks a tool that is genuinely
*mid-execution* (§2.4). Lying about that state machine to the UI would
corrupt continuation semantics. Asks ride a custom `data-ask` part
(reconciled by stable id: pending → answered), and clients answer via
the control plane.

### 2. One truth, one view

The kernel persists **execution facts**: the Trace (durable rows,
per-ring `seq`, replay-then-tail, no-gap — §2.7). The serving tier's
conversation transcript (`conversationId → UIMessage[]`) is a
**materialized view** of those facts:

- user message = the admitted work item (the durable `run.admitted` row)
- assistant message = the run's rows folded into parts

The view lives in an in-memory Map locally and DO SQLite on Cloudflare
(the same split `AIChatAgent` ships), and is rebuildable from the Trace
either way. The kernel stays session-free (runs keyed by work item —
the agent/loop algebra decision); a conversation id is just a
work-item's world identity. Recorded trade-off: kernel-level sessions
were considered and rejected — they reverse the session-free decision
and complicate ring identity, while the serving-tier view is a two-way
door (if recovery work later demands trace-resident transcripts, the
view migrates by construction).

### 3. One path: admission + window (never a blocking call)

The API only ever **`send`s** (admission) to a ring. A "synchronous"
chat response is admission + a trace subscription from the admission
cursor, folded into chunks, ending at `turn.halted`:

- The run executes on the ring's fiber, never the request's.
- Disconnects kill the *window*, not the run. Reconnect = replay from
  cursor — the no-gap guarantee `TraceStore` already provides. This is
  the property `AIChatAgent` rebuilds with SQLite chunk buffering; the
  Trace has it natively.
- Overlapping sends queue on the serial mailbox (Cloudflare's
  `messageConcurrency: "queue"`, for free).
- Fire-and-forget API calls are the same admission with no window
  (202; observe later via the trace endpoint).

"Rows are truth, wakes are hints" (§2.7) thereby describes both crash
recovery and HTTP reconnects — one primitive, two consumers.

### 4. The trace endpoint is durable-streams-shaped

`TraceStore` already *is* a [Durable Stream](https://durablestreams.com/quickstart):
offset-addressable, append-only, replay-then-tail. The trace endpoint
mirrors their shape (`?offset=N&live=sse`, `Stream-Next-Offset`
header) without chasing full spec compliance this push; full protocol
compatibility (their clients/integrations) is a later rung.

## Surface (local server, `src/AI/Api/`)

| Endpoint | Protocol | Backed by |
| --- | --- | --- |
| `POST /api/chat` | AI SDK UI message stream (SSE) | ChatSessions → ring admission → chunk adapter |
| `GET /api/chat/:id/stream` | same (reconnect) | trace replay from cursor |
| `GET /v1/stream/:ring` | durable-streams-shaped SSE | `TraceStore.trace(ring, offset)` |
| `GET /api/asks`, `POST /api/asks/:id` | JSON | `AskHub.pending` / `.answer` |
| `POST /api/agents/:name/steer` / `interrupt` | JSON | `ProcessService.steer` / `.interrupt` |

Served on `effect/unstable/http` (`HttpRouter` +
`HttpServerResponse.stream`) over the repo's `BunHttpServer`.
`HttpApiSchema.StreamSse` exists and is attractive (typed events,
OpenAPI) but the AI SDK's exact framing (`v1` header, `[DONE]`
literal) is a byte-level contract — the chat routes hand-frame; the
control plane may move to `HttpApi` when it grows.

## Implementation status

- ✅ **Protocol schemas** (`Protocol.ts`): chunk subset (`start/finish/
  abort`, step boundaries, text blocks, tool input/output, `data-ask`,
  `error`), lenient `UIMessage`/`ChatRequest` decoding (unknown part
  types never reject a transcript), SSE framing + golden wire tests.
- ✅ **Kernel enrichment + the fold** (`Chunks.ts`): every run now
  opens with a durable `run.admitted` row carrying the work item (the
  run's input is reconstructible from the Trace alone); `tool.requested`
  carries `params`, `tool.completed/.failed` carry `result`, and a
  `Completed` `turn.halted` carries the final `text`. The
  `KernelEvent → UIMessageChunk` fold is one pure state machine
  (`foldEvent`) shared by both sources: the **live** firehose streams
  `model.delta` rows as text deltas, while a **trace replay** (deltas
  are live-only) synthesizes the text block from the halt row — so
  reconnects render the full message and the two paths cannot drift
  (tested for agreement against real kernel emissions, scripted and
  live). One wrinkle worth recording: kernel event order is
  `model.completed` *then* `tool.*` (tools run after the wire call
  returns), but the AI SDK expects tool parts *inside* their step — so
  the fold closes a step lazily at the next round boundary rather than
  at `model.completed`.
- ✅ **`ChatSessions`** (`ChatSessions.ts`): the conversation registry.
  `send(conversationId, message)` appends the user half, **admits** the
  item to the process ring (`ProcessService.send` — fire-and-forget, so
  the run lives on the ring's fiber), and returns the run's chunk
  window; the window is correlated by watching the firehose for the
  admission's `run.admitted` row and following that session to the
  halt. When the window closes — attached or not — the collected chunks
  materialize into the assistant `UIMessage` (`chunksToMessage`, parts
  reconciled in place the way `useChat` builds them) and land in the
  transcript. Asks flow through the same service: parked asks surface
  via `asks`, answers via `answer`, and the chunk stream shows the
  `data-ask` part flip pending → answered on one stable part id.
  Correlation note: item-equality matching on `run.admitted` is exact
  for distinct items; two conversations racing identical items on one
  ring could cross-correlate — acceptable now, fixed for real when
  admission returns its session key (Phase 2 typed admission).
- ✅ **`AgentApi`** (`AgentApi.ts`): the routes as an `HttpRouter.use`
  Layer — harness-agnostic (Bun today, the Ring DO later). `POST
  /api/chat` decodes the `useChat` body, admits the last user message
  via `ChatSessions`, and hand-frames the SSE window (the AI SDK's
  framing is a byte-level contract; no codec re-derivation). `GET
  /api/chat/:id` serves the materialized transcript. `GET
  /v1/stream/:ring?offset=N` is the durable-streams-shaped trace
  window (each frame's SSE id is its `seq`, so resumption is the same
  cursor). `GET/POST /api/asks[/:id]` is the Ask control plane (ask
  ids contain `/` — percent-encoded on the wire); `POST /api/steer` /
  `/api/interrupt` expose process authority when a handle is given.
  Services resolve at Layer build (not per request), so the routes
  Layer requires `ChatSessions | Kernel` and handlers stay
  requirement-free. Tested end to end over a real ephemeral-port HTTP
  server + client: chat SSE (headers, chunk envelope, tool payloads,
  `[DONE]`), ask round-trip over HTTP unblocking a parked run, trace
  replay with contiguous seqs, and a live-Anthropic run through the
  whole HTTP path. Reconnect of an in-flight chat window is served by
  the trace endpoint for now; a `useChat`-native resume route rides
  the deferred ladder.
- ✅ **`examples/agent-chat-web`**: the React proof. Stock `useChat` +
  `DefaultChatTransport({ api: "/api/chat" })` — no custom transport,
  no adapter. The client renders three part kinds: `text`,
  `dynamic-tool` (tool cards), and `data-ask` (approval card posting
  to `/api/asks/:id`). The server (`server.ts`) is ~100 lines: an
  `AI.Agent` term (a dice-parlor croupier), two tool Layers,
  `ChatSessions`, `agentApi()`, `BunHttpServer`. Verified over the
  wire: tool round streams, approval flow parks → answers → resumes,
  Vite build passes. Two lessons banked:
  - **Bun's `idleTimeout` defaults to 10s** and severs SSE windows
    mid-run — serve with `idleTimeout: 0`.
  - The example exposed a latent **Tool tag collision**: `makeTool`
    produced tags with no ServiceMap key, so every tool in one context
    resolved to the last-provided handler (`roll_dice` executed the
    approval physics). Tests never caught it because each existing
    suite provided one tool per context or scoped physics per-agent
    via `AI.layer`. Fixed by grafting a real
    `Context.Service` tag (`alchemy/AI/Tool/{name}`) onto the callable
    term via the prototype chain — `class extends` would have broken
    the `Grep(impl)` ToolImpl call form. Tool names are now identity.

## The chat app layer

How chat apps are built *on top of* this serving tier — philosophy
(shadcn's scroll engineering as normative UX law, open-code component
vendoring, transcripts as projections of Trace facts), the part→
component mapping, package choices, and the kernel gaps the UI
surfaces (reasoning parts, `data-run`, conversation index) — is
designed in **[chat-apps.md](./chat-apps.md)**.

## Deferred ladder

1. WebSocket transport + multi-client broadcast (`useAgentChat`
   parity; effect RPC `layerProtocolWebsocket` is the natural carrier
   for the typed control plane then).
2. OpenTUI terminal client over the same protocol.
3. Cloudflare harness serving: the same `AgentApi` from the Ring DO —
   transcript view moves to DO SQLite, trace subscription to the
   durable Trace, protocol unchanged.
4. Full Durable Streams spec compliance for the trace endpoint;
   client-side tools (`onToolCall`); resumable per-message streams.
