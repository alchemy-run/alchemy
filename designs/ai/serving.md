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
- ☐ Kernel enrichment: durable `run.admitted` row (work item + world
  identity — closes the transcript-derivability gap), tool `params`/
  `result` payloads; the pure `KernelEvent → UIMessageChunk` adapter.
- ☐ `ChatSessions` (transcript view; admission; fold; ask mapping).
- ☐ `AgentApi` HTTP layer + in-process and live tests.
- ☐ `examples/agent-chat-web` (React `useChat` proof).

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
