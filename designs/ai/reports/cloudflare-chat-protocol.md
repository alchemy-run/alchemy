# Cloudflare Agents chat wire protocol — source-level report

Research target: `/Users/samgoodwin/workspaces/alchemy-effect/.vendor/agents` (the `cloudflare/agents` monorepo). All paths below are relative to that repo root. Line numbers are from the checked-out revision (Jul 28 2026 clone).

## Executive summary

Cloudflare's chat stack runs **everything over one JSON-text WebSocket** per (client, agent-DO) pair, opened by `useAgent` (a thin wrapper around PartySocket) at `/agents/{kebab-class}/{instance-name}`. The base `agents` package multiplexes four protocol families on that socket by a top-level `type` string: identity/state-sync (`cf_agent_state`, `cf_agent_identity`, `cf_agent_mcp_servers`), RPC (`type: "rpc"` with request-id correlation), and — layered on top by `@cloudflare/ai-chat` — the chat protocol (`cf_agent_chat_*` / `cf_agent_stream_*` / `cf_agent_tool_*`). Anything unrecognized falls through to the consumer's `onMessage`.

A chat turn is submitted as a single WS frame that *cosplays as an HTTP request* (`cf_agent_use_chat_request` carrying `{id, init: {method: "POST", body}}` — a fossil of the older fetch-based transport). The server runs the user's `onChatMessage()`, takes the returned AI SDK `Response`, and **the DO itself consumes the SSE body stream**: each `data:` line is parsed back into a `UIMessageChunk`, written to a SQLite chunk buffer (`cf_ai_chat_stream_chunks`, batched 10 chunks/row), and re-broadcast to *all* connected sockets as `cf_agent_use_chat_response` frames (`{id, body: "<chunk JSON>", done: false}`). So the "stream" the client sees is chunk-by-chunk re-serialized JSON inside JSON, fanned out by DO broadcast — not the HTTP response body.

On the client, `useAgentChat` wraps AI SDK v6 `useChat` with a custom `ChatTransport` (`WebSocketChatTransport`): `sendMessages` sends the request frame and returns a `ReadableStream<UIMessageChunk>` fed by a socket listener filtered on the request id; `reconnectToStream` implements a probe/offer/ack resume handshake (`stream_resume_request` → `stream_resuming`|`stream_pending`|`stream_resume_none` → `stream_resume_ack` → replay of every stored chunk with `replay: true`, then `replayComplete` or `done`). Resumption is **full replay from chunk 0** — there are no offsets or cursors anywhere in the protocol; idempotency is achieved client-side by resetting the accumulator on every replayed `start` chunk.

Persistence is two-layered: the transcript lives in `cf_ai_chat_agent_messages` (one row per UIMessage, JSON blob, upsert-by-id, incremental via a serialized-JSON cache) and is broadcast to other tabs as full message-array snapshots (`cf_agent_chat_messages`); the in-flight stream lives in the chunk tables and survives hibernation, letting a rehydrated DO finish an "orphaned" stream by replaying stored chunks, marking it done, and reconstructing/persisting the partial assistant message. Abort is a client frame (`cf_agent_chat_request_cancel`) resolved through a per-request `AbortController` registry; client tools and approvals are frames (`cf_agent_tool_result` / `cf_agent_tool_approval`) that mutate the persisted message and optionally trigger a server-initiated "continuation" stream which the client attaches to via the same resume handshake. Hibernation is on by default; the streaming loop holds an alarm-heartbeat `keepAliveWhile` to prevent idle eviction, and per-connection flags survive hibernation inside the WebSocket attachment.

An enormous fraction of the code (pre-stream parking `#1784`, terminal replay `#1645`, replay dedup `#1733`, recovery fibers `#1620/#1626`, submit-concurrency, auto-continuation barriers `#1650`) is **compensation for not having a durable, ordered event log with a cursor**. Our kernel's per-run monotonic `seq` observation log makes most of that machinery unnecessary — see the final section.

---

## 1. Socket + framing

### What `useAgent` opens

`useAgent` (`packages/agents/src/react.tsx:280-1055`) delegates to `usePartySocket` with:

```642:650:.vendor/agents/packages/agents/src/react.tsx
    : {
        party: agentNamespace,
        prefix: "agents",
        room: options.name || "default",
        path: combinedPath || undefined,
        query: resolvedQuery,
        ...restOptions,
        shouldReconnectOnClose: classifyReconnect
      };
```

PartySocket builds `wss://{host}/{prefix}/{party}/{room}` — i.e. **`/agents/{kebab-case-class-name}/{instance-name}`** (plus optional trailing `path`, plus `/sub/{child}/{name}` segments for nested "facet" agents, `react.tsx:82-99`). The server side confirms the shape: `routeAgentRequest` is `routePartykitRequest(request, env, { prefix: "agents", ... })` (`packages/agents/src/index.ts:12921-12931`), and a comment notes "with default routing the name is already visible in the URL path (/agents/{class}/{name})" (`index.ts:2603-2605`). The client docs show the same: `// Standard: /agents/my-agent/room/settings` (`packages/agents/src/client.ts:92-93`).

- **No WebSocket subprotocol.** Framing is purely JSON text messages discriminated on `type`.
- **Auth**: user-supplied `query` params (a static object or an async `() => Promise<QueryObject>` for token refresh, cached with a TTL and re-fetched on reconnect — `react.tsx:163-167, 479-570`), plus whatever `headers`/cookies the HTTP upgrade carries. PartySocket also appends its own `_pk` connection-id query param (referenced at `chat/react.tsx:742`).
- On connect the server pushes, in order: `cf_agent_identity` `{name, agent}`, `cf_agent_state` `{state}` (if any), `cf_agent_mcp_servers` `{mcp}` (`packages/agents/src/index.ts:2618-2653`).

### Frame families multiplexed on the one socket

Base protocol (`packages/agents/src/types.ts:4-13`):

| `type` | direction | payload |
|---|---|---|
| `cf_agent_identity` | S→C | `{name, agent}` |
| `cf_agent_state` | both | `{state}` — full-state sync; client `setState` sends the same shape up (`react.tsx:1001-1009`) |
| `cf_agent_state_error` | S→C | `{error}` (e.g. readonly connection) |
| `cf_agent_mcp_servers` | S→C | `{mcp: MCPServersState}` |
| `rpc` | both | request `{type:"rpc", id, method, args[]}` (`index.ts:199-203`); response `{type:"rpc", id, success, result, done?}` or `{success:false, error}` (`index.ts:216-234`); streaming RPC repeats responses with `done:false` then final `done:true` |
| `agent-tool-event` | S→C | sub-agent tool progress events (`react.tsx:1088-1101`) |

The client dispatches by parsing every text frame once and switching on `type` (`react.tsx:687-804`); unknown types fall through to `options.onMessage`. Server-side, `AIChatAgent` wraps `onMessage` and classifies with the shared `parseProtocolMessage` (`packages/agents/src/chat/parse-protocol.ts`); non-chat frames forward to the consumer (`packages/ai-chat/src/index.ts:931-937`).

### The complete chat frame vocabulary

Defined once in `packages/agents/src/chat/wire-types.ts:7-47` (enum) and mirrored as wire strings in `chat/protocol.ts:18-47`. Client→server (`IncomingMessage`, `wire-types.ts:134-214`):

- `cf_agent_use_chat_request` — `{type, id, init: Pick<RequestInit, "method"|"body"|...>}`. The turn submission. `init.body` is a JSON string: `{messages: UIMessage[], trigger: "submit-message"|"regenerate-message", clientTools?, ...customBody}`.
- `cf_agent_chat_messages` — `{type, messages: UIMessage[]}`. Client replaces server transcript (used by `setMessages` sync; server persists it, `index.ts:1305-1309`).
- `cf_agent_chat_clear` — `{type}`.
- `cf_agent_chat_request_cancel` — `{type, id}`.
- `cf_agent_stream_resume_request` — `{type, probeId?}` (probe; `probeId` is an opaque correlation nonce).
- `cf_agent_stream_resume_ack` — `{type, id}` (accept a resume offer for request `id`).
- `cf_agent_tool_result` — `{type, toolCallId, toolName, output, state?: "output-available"|"output-error", errorText?, autoContinue?, clientTools?}`.
- `cf_agent_tool_approval` — `{type, toolCallId, approved, autoContinue?}`.

Server→client (`OutgoingMessage`, `wire-types.ts:52-129`):

- `cf_agent_use_chat_response` — **the streamed chunk frame**: `{type, id, body: string, done: boolean, error?, continuation?, replay?, replayComplete?}`. `body` is a serialized `UIMessageChunk` (or error text when `error: true`, or `""` on the terminal `done: true` frame). `continuation: true` = append to the last assistant message; `replay: true` = replayed from storage; `replayComplete: true` = stored replay finished but the stream is still live.
- `cf_agent_chat_messages` — `{type, messages}` full-snapshot broadcast.
- `cf_agent_chat_clear` — `{type}`.
- `cf_agent_stream_resuming` — `{type, id, probeId?}` resume offer for request `id`.
- `cf_agent_stream_resume_none` — `{type, reason?: "idle"|"continuation-owned", probeId?}`.
- `cf_agent_stream_pending` — `{type, id?, probeId?}` "turn accepted, stream not started yet, keep waiting" (#1784).
- `cf_agent_message_updated` — `{type, message: UIMessage}` single-message upsert (tool result/approval applied).
- `cf_agent_chat_recovering` — `{type, recovering: boolean, id?}` advisory "durable recovery in progress" hint (#1620).

**Multiplexing/correlation rule:** chat stream frames correlate exclusively by the client-minted request id (`nanoid(8)` in the transport); resume probes correlate by `probeId`; RPC by its own `id`; state sync is uncorrelated broadcast. There is no channel/stream framing beyond these ids.

---

## 2. Submitting a turn

### What crosses the wire

`sendMessage` (AI SDK) → `WebSocketChatTransport.sendMessages` (`packages/agents/src/chat/ws-chat-transport.ts:296-475`). **A WS frame, not an HTTP POST** — but shaped like one:

```461:472:.vendor/agents/packages/agents/src/chat/ws-chat-transport.ts
    // Send the request over WebSocket
    requestSent = true;
    agent.send(
      JSON.stringify({
        id: requestId,
        init: {
          method: "POST",
          body: bodyPayload
        },
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST
      })
    );
```

`bodyPayload` is `JSON.stringify({messages, trigger, ...extraBody})` (`ws-chat-transport.ts:327-331`), with `extraBody` assembled by `prepareBody` (top-level `body` option, deprecated client-tool schemas, user's `prepareSendMessagesRequest` — `chat/react.tsx:967-1002`). `sendMessages` synchronously returns a `ReadableStream<UIMessageChunk>` whose `start()` registers a socket `message` listener that (a) filters `type === cf_agent_use_chat_response && data.id === requestId`, (b) `JSON.parse(data.body)` → `controller.enqueue(chunk)`, (c) errors the stream on `data.error`, closes on `data.done` (`ws-chat-transport.ts:397-449`). The request id is registered in the shared `activeRequestIds` set so the hook's broadcast handler ignores frames the transport already owns (`ws-chat-transport.ts:333-334`).

The only HTTP the chat client performs is the initial history fetch: default `getInitialMessages` GETs `{agentHttpUrl}/get-messages` (`chat/react.tsx:837-868`), served by the agent's `onRequest` (`ai-chat/src/index.ts:1431-1439`).

### How the server turns a `Response` into WS frames

`AIChatAgent`'s wrapped `onMessage` parses the frame, persists+broadcasts the user messages, then inside an exclusive turn queue calls the user hook and hands its `Response` to `_reply` (`packages/ai-chat/src/index.ts:1189-1224`):

```1189:1201:.vendor/agents/packages/ai-chat/src/index.ts
                          const response = await this.onChatMessage(
                            async (_finishResult) => {
                              // User-provided hook. Cleanup is now handled by _reply,
```

`_reply` (`index.ts:6658-6928`) is the consumer of the `Response` body — it runs **inside the DO**, wrapped in `keepAliveWhile` ("Keep the DO alive during streaming to prevent idle eviction", `index.ts:6672-6673`). It allocates a streaming assistant `UIMessage`, registers a resumable stream (`_startStream`), then `response.body.getReader()` and dispatches on content-type: `text/event-stream` → `_streamSSEReply`, anything else → `_sendPlaintextReply` (which synthesizes `text-start`/`text-delta`/`text-end` chunks, `index.ts:6502-6600`).

`_streamSSEReply` (`index.ts:6037-6499`) is the per-chunk loop. For every SSE `data:` line it: parses the `UIMessageChunk`; applies it to the in-memory assistant message via the shared `applyChunkToParts`; filters provider replay chunks (`isReplayChunk`, #1404); rewrites `start` chunks (strips `messageId` on continuations #1229, **stamps the server-allocated assistant id onto `start` when the provider emitted none**, so client and server build the message under the same id, `index.ts:6428-6453`); converts `finish.finishReason` into `messageMetadata` (#677); then:

```6467:6476:.vendor/agents/packages/ai-chat/src/index.ts
            // Store chunk for replay and broadcast to clients
            const chunkBody = JSON.stringify(eventToSend);
            await this._storeStreamChunk(streamId, chunkBody);
            this._broadcastChatMessage({
              body: chunkBody,
              done: false,
              id,
              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
              ...(continuation && { continuation: true })
            });
```

So **each streamed chunk on the socket is one `cf_agent_use_chat_response` frame whose `body` is the JSON-serialized UIMessageChunk**, broadcast to every connection (minus pending-resume ones), including the originator — the originating tab's transport consumes it via the request-id filter, other tabs via the broadcast accumulator. On reader `done`: `_completeStream(streamId)` + a terminal `{body: "", done: true, id}` frame (`index.ts:6122-6134`). An in-stream `error` chunk broadcasts `{error: true, body: errorText, done: false}` then a terminal `done` frame and marks the stream errored (`index.ts:6392-6415`). After the loop, `_reply` persists the completed assistant message via `persistMessages` (`index.ts:6859-6903`).

Notable: `_broadcastChatMessage` excludes connections that are mid-resume-handshake so they don't see live chunks interleaved with their replay (`index.ts:2005-2014`).

---

## 3. `useAgentChat` internals

Yes — it wraps AI SDK v6 `useChat` with a custom `ChatTransport`. The file header of `ws-chat-transport.ts` states the design:

```1:9:.vendor/agents/packages/agents/src/chat/ws-chat-transport.ts
/**
 * WebSocket-based ChatTransport for useAgentChat.
 *
 * Replaces the aiFetch + DefaultChatTransport indirection with a direct
 * WebSocket implementation that speaks the CF_AGENT protocol natively.
 *
 * Data flow (old): WS → aiFetch fake Response → DefaultChatTransport → useChat
 * Data flow (new): WS → WebSocketChatTransport → useChat
 */
```

The transport is a **true singleton per hook instance** kept in a ref ("created once, never recreated ... so the resolver set by reconnectToStream and the handleStreamResuming call from onAgentMessage always operate on the SAME instance", `chat/react.tsx:949-1010`), re-pointed at the latest socket every render via `setAgent`. It is passed to `useChat` with `resume: false` — the hook owns all resume entry points itself so mount/reconnect/tool-continuation share one serialization gate (`chat/react.tsx:1018-1029`, #1837).

**`sendMessages`** — quoted in §2: mint `nanoid(8)` request id, send `cf_agent_use_chat_request`, return a socket-fed `ReadableStream<UIMessageChunk>`. Abort semantics are configurable: by default a generic AI SDK abort is **local-only** ("durable server turns can continue and be resumed"); `cancelOnClientAbort: true` or explicit `cancelActiveServerTurn()` sends `cf_agent_chat_request_cancel` (`ws-chat-transport.ts:377-391, 146-159`).

**`reconnectToStream`** (`ws-chat-transport.ts:477-589`) — a probe with three resolutions, implemented not with its own listener but with "identity-owned callbacks consumed synchronously by the shared handler" (the hook's single `onAgentMessage` calls `transport.handleStreamResuming/handleStreamResumeNone/handleStreamPending`):

```551:587:.vendor/agents/packages/agents/src/chat/ws-chat-transport.ts
      resumeResolver = (data: { id: string }) => {
        const requestId = data.id;
        activeIds?.add(requestId);
        const stream = this._createResumeStream(requestId);

        this.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: requestId
          })
        );

        done(stream);
      };
      // ...
      retryResumeProbe = () => {
        if (resolved) return;
        armTimeout(RESUME_PROBE_TIMEOUT_MS);
        try {
          this.agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
              probeId
            })
          );
```

Timeouts: 5 s default probe backstop, extended to 60 s (refreshed per frame) when the server answers `stream_pending` (`ws-chat-transport.ts:20-30, 540-543`). A third path, `_createToolContinuationStream` (`ws-chat-transport.ts:597-808`), returns a *deferred* stream immediately after a tool result/approval so `useChat` status flips to `"submitted"` before the server's continuation stream exists, then binds to the eventual `stream_resuming` offer.

What the hook re-implements *around* `useChat` (all in `chat/react.tsx`): initial-history fetch with Suspense + request cache (`:873-903`); a stable Chat id so socket churn doesn't recreate the AI SDK Chat (`:774-826`); the unified `onAgentMessage` dispatcher (`:1858-2261`) handling clears, snapshots, message updates, resume frames, and a **broadcast accumulator** (`broadcast-state.ts` + `stream-accumulator.ts`) that builds observed streams (other tabs / fallback resume) into messages outside the transport path; client-tool execution (`onToolCall`) and approval plumbing; and stop/continuation state machines.

---

## 4. Resumable streams

### Where chunks live

SQLite, always — never memory-only. `ResumableStream` (`packages/agents/src/chat/resumable-stream.ts`) owns two tables (`:178-194`):

```sql
create table cf_ai_chat_stream_chunks  (id text primary key, stream_id text not null, body text not null, chunk_index integer not null, created_at integer not null);
create table cf_ai_chat_stream_metadata (id text primary key, request_id text not null, status text not null, -- 'streaming'|'completed'|'error'
                                         created_at integer not null, completed_at integer, message_id text, is_continuation integer);
```

Writes are batched: an in-memory buffer flushes to **one packed row** (JSON array of chunk bodies) every 10 chunks, or when the segment would exceed 512 KB raw, or at 100 buffered chunks; a single chunk > 1.8 MB is *dropped from storage entirely* (still broadcast live) to avoid the 2 MB SQLite row limit (`resumable-stream.ts:19-29, 356-403`). `chunk_index` is a per-flush segment counter, restored past the max stored value on rehydrate (`:703-712`).

### The resume handshake

No offsets, no cursors, no client-side position: **resume = full replay from chunk 0**. Server side is `ResumeHandshake` (`packages/agents/src/chat/resume-handshake.ts`):

1. On connect (proactive) and/or on client `stream_resume_request` (post-handler-registration probe), the server answers from a decision tree (`resume-handshake.ts:122-179`): active stream → `stream_resuming {id}`; continuation owned by another live connection → `stream_resume_none {reason: "continuation-owned"}`; accepted-but-not-yet-streaming turn → park the connection + `stream_pending` (#1784); a terminal error captured while nobody was connected → fake a `stream_resuming` so the error can be delivered on a resumed stream (#1645); otherwise → `stream_resume_none {reason: "idle"}` (the only frame that proves global inactivity).
2. Client ACKs with `stream_resume_ack {id}`. Until the ACK, the connection sits in `pendingResumeConnections` and is excluded from live broadcast (`resume-handshake.ts:110-114`, `ai-chat/index.ts:2005-2014`).
3. On ACK the server replays **every stored chunk** as `cf_agent_use_chat_response {replay: true}` frames, then: live stream → `{replay: true, replayComplete: true, done: false}` and the connection rejoins live broadcast; orphaned stream (rehydrated after hibernation, no reader) → `{replay: true, done: true}` + mark completed + reconstruct/persist the partial message; unknown id with a completed buffer in the 10-minute grace window → replay + done; otherwise a bare `{done: true, replay: true}` (`resumable-stream.ts:466-563`, `resume-handshake.ts:220-261`).

Replay idempotency is client-side: every replayed `start` chunk **re-initializes the accumulator** ("replaying into an accumulator that already holds this stream's parts would duplicate them", `broadcast-state.ts:88-105`) and resets any hydrated trailing assistant (`chat/react.tsx:2118-2135, 2176-2196`). Duplicate `stream_resuming` offers (server sends from both onConnect and the probe handler, #1733) are deduped by `localRequestIdsRef` / `fallbackAckedResumeRequestIdsRef` (`chat/react.tsx:2035-2045`).

### New client joining mid-stream

Identical path — there is no distinction between "reconnect" and "new tab": onConnect the server proactively sends `stream_resuming` (`ai-chat/index.ts:875-877`), the tab ACKs (transport path if it's resuming a Chat, else the hook's fallback observer path which ACKs directly and feeds the broadcast accumulator, `chat/react.tsx:2054-2074`), gets the full chunk replay, then live frames.

### Across hibernation/eviction

The DO constructor recreates `ResumableStream`, whose `restore()` reloads the newest `status='streaming'` metadata row (`resumable-stream.ts:686-714`); `_isLive` stays `false`, marking it **orphaned** ("the ReadableStream was lost when the DO was evicted", `:156-162`). The orphan is finalized lazily on the next client ACK (replay + done + `persistOrphanedStream` reconstructs the partial assistant message from stored chunks via the shared `StreamAccumulator` and upserts it, `ai-chat/index.ts:1761-1790`, `resume-handshake.ts:236-241`). Without a client, alarm-driven sweeps reap buffers (completed: 10 min after completion; abandoned streaming rows: 60 min after last chunk activity, `resumable-stream.ts:43-53, 781-832`). Actually *continuing* the generation after eviction is a separate opt-in layer (`chatRecovery` durable fibers, `docs/agents/resumable-streaming.md:5`: "This is client reconnect recovery, not Durable Object eviction recovery"), which snapshots turn inputs (`_runChatRecoveryFiber`, `ai-chat/index.ts:663-691`) and re-drives the turn as a continuation, signalling clients with `cf_agent_chat_recovering`.

---

## 5. Persistence + broadcast

**Schema** (`ai-chat/index.ts:813-824`):

```813:824:.vendor/agents/packages/ai-chat/src/index.ts
            this.sql`create table if not exists cf_ai_chat_agent_messages (
              id text primary key,
              message text not null,
              created_at datetime default current_timestamp
            )`;

            // Key-value table for request context that must survive hibernation
            // (e.g., custom body fields, client tools from the last chat request).
            this.sql`create table if not exists cf_ai_chat_request_context (
              key text primary key,
              value text not null
            )`;
```

One row per UIMessage, whole message as a JSON blob, ordered by `created_at`. (Plus the two stream tables in §4 and `cf_ai_chat_agent_tool_runs` for sub-agent tool attribution.)

**When writes happen:**
- **User messages**: immediately on receiving the chat request, *before* the turn queue — broadcast `cf_agent_chat_messages` to other tabs (excluding the sender) then `persistMessages(transformedMessages, [connection.id], {_deleteStaleRows: true})` (`ai-chat/index.ts:1043-1055`).
- **Assistant message**: after the stream loop finishes, in `_reply` (`:6859-6903`); plus an **early persist** the moment a `tool-approval-request` chunk streams (so Approve/Reject UI survives refresh — direct SQL upsert, deliberately *not* broadcast, `:6248-6270`).
- **Tool results/approvals**: applied to the persisted message on the corresponding frames, then pushed as `cf_agent_message_updated`.

`persistMessages` (`:5388-5460`) reconciles the incoming array against server state (`reconcileMessages` can remap client ids to server ids), sanitizes, enforces a row-size limit, **skips SQL for messages whose serialized JSON is unchanged** (a `_persistedMessageCache`), upserts by id, optionally deletes stale rows (only when the incoming set is a subset of server state — regenerate-trim), reloads `this.messages` from DB, and finally broadcasts the snapshot:

```5453:5459:.vendor/agents/packages/ai-chat/src/index.ts
    this._broadcastChatMessage(
      {
        messages: mergedMessages,
        type: MessageType.CF_AGENT_CHAT_MESSAGES
      },
      excludeBroadcastIds
    );
```

**Sync message shapes:** full-array snapshot (`cf_agent_chat_messages`), single-message upsert (`cf_agent_message_updated` — client matches by id, falling back to `toolCallId`, and deliberately never appends, #1094, `chat/react.tsx:1924-1978`), and clear (`cf_agent_chat_clear`, which on the server wipes all four tables + terminal records + pre-stream state, `ai-chat/index.ts:1280-1302`). Other tabs' live rendering of an in-flight turn does **not** come from snapshots but from observing the broadcast chunk frames via the accumulator (§3).

---

## 6. Abort, regeneration, optimistic state

**Stop/abort**: `stop()` in the hook calls `customTransport.cancelActiveServerTurn()` (sends `{type: cf_agent_chat_request_cancel, id}`) + AI SDK `stop()` + aborts any tool-continuation stream (`chat/react.tsx:1217-1224`). Server side: `this._abortRegistry.cancel(event.id)` (`ai-chat/index.ts:1312-1316`) fires the per-request `AbortController` (`chat/abort-registry.ts:11-122`); the signal was passed into `onChatMessage` and is also wired as a safety net that cancels the response reader directly (`:6054-6066`). The abort path still emits a final `{body:"", done:true}` frame (`:6484-6496`) so every client terminates its stream. Crucially, the default is **detach-don't-cancel**: page nav/React cleanup closes the local stream only, leaving the durable turn running for later resume (`ws-chat-transport.ts:377-390`).

**Regeneration** is just `trigger: "regenerate-message"` in the request body; the client sends the trimmed message array and the server's `_deleteStaleRows` subset-check deletes the trailing assistant row (`ai-chat/index.ts:5419-5443`).

**Avoiding double-applied optimistic state** — four mechanisms:
1. **Sender exclusion**: every server broadcast triggered by a connection's own action excludes that connection id (`[connection.id]` at `ai-chat/index.ts:1043-1049`, `excludeBroadcastIds` threaded into `_reply`/`persistMessages`), so the originating tab never receives an echo of its own user message snapshot.
2. **Transport ownership**: frames for a request id in `activeRequestIds` are consumed exclusively by the transport's stream; the hook's broadcast handler returns early for them (`chat/react.tsx:2079, 2162`).
3. **Shared assistant id**: the server stamps its allocated assistant id into the `start` chunk (§2), so the live-streamed message and the later persisted snapshot reconcile by id instead of duplicating.
4. **Streaming-tail protection**: `protectStreamingAssistantTail` latches the streaming assistant id at send time (re-armed to the actual id from the `start` chunk, `chat/react.tsx:2091-2117`) so a mid-stream `cf_agent_chat_messages` snapshot can't replace the live-streamed message with a behind-the-stream copy; the observer path applies the analogous accumulator-ahead-of-snapshot merge (`chat/react.tsx:1888-1920`).

---

## 7. Client tools / HITL over the socket

The turn does **not** stay open waiting for the browser. When the model emits a client-tool call (a tool with no server `execute`) or an approval request, the assistant turn simply *ends* (stream completes; for approvals the message is early-persisted in `approval-requested` state, §5). The pause is materialized as persisted message state, not a suspended request.

Client side, the hook detects trailing `input-available` tool parts and invokes `onToolCall({toolCall, addToolOutput})` (`chat/react.tsx:1767-1840`). `addToolOutput` / approval UIs send:

```1716:1732:.vendor/agents/packages/agents/src/chat/react.tsx
      agentRef.current.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_RESULT,
          toolCallId,
          toolName,
          output,
          ...(state ? { state } : {}),
          ...(errorText !== undefined ? { errorText } : {}),
          // ...
          autoContinue: shouldAutoContinue,
          clientTools: toolsRef.current
            ? extractClientToolSchemas(toolsRef.current)
            : undefined
        })
      );
```

(approvals: `{type: cf_agent_tool_approval, toolCallId, approved, autoContinue}`, `:1749-1756`). **Correlation is entirely by `toolCallId`** — the server finds the owning persisted message, mutates the tool part (`_applyToolResult` / `_applyToolApproval`), broadcasts `cf_agent_message_updated`, and if `autoContinue` is set schedules an **auto-continuation**: a new server-initiated turn (new request id) whose stream reuses the resume machinery — the client pre-arms `transport.expectToolContinuation()` and `resumeStream()`, and the deferred stream binds to the continuation's `stream_resuming` offer (`chat/react.tsx:1142-1206`, `ws-chat-transport.ts:189-203, 597-808`). A parallel-tool-batch barrier holds the continuation until every sibling tool call in the batch has resolved (#1650, re-armed via `_rearmPendingAutoContinuationForBatch`, `ai-chat/index.ts:1377-1384`). Continuation streams clone the last assistant message server-side and carry `continuation: true` on every frame so clients append rather than rebuild (§2, §4).

---

## 8. Hibernation specifics

- Hibernation is **on by default**: `static options = { hibernate: true }` (`packages/agents/src/index.ts:1280-1282, 1782`), using partyserver's hibernatable-WebSocket server.
- **Attachment shape**: per-connection state is persisted in the WebSocket's serialized attachment (partyserver defines `connection.state` as a getter over the attachment). The agents layer stores internal `_cf_`-prefixed flags (readonly, no-protocol, voice flags) *inside the same attachment*, wrapped so user `setState` can't clobber them: `_ensureConnectionWrapped` re-captures raw accessors idempotently — "After hibernation, the _rawStateAccessors WeakMap is empty but the connection's state getter still reads from the persisted WebSocket attachment" (`index.ts:2971-3102`). Everything else the chat layer needs on wake is in SQLite, restored in the constructor: messages, request context (`cf_ai_chat_request_context` — "request context that must survive hibernation (e.g., custom body fields, client tools from the last chat request)", `ai-chat/index.ts:819-836`), and the active stream (`ResumableStream.restore()`).
- **Rehydration flow on wake**: constructor rebuilds tables/caches; `pendingResumeConnections`, continuation parks, and pre-stream parks are all in-memory and empty — which is fine because clients re-probe (`stream_resume_request`) on every socket open/remount, and the handshake decision tree reconstructs the situation from durable state (active `streaming` metadata row → offer; terminal record → terminal replay; else none). The hibernatable `webSocketMessage` handler always delivers frames regardless; `binaryType` is re-pinned per isolate (`index.ts:2986-3015`).
- **Does an in-flight turn prevent hibernation?** Effectively yes, while it runs: the streaming loop executes inside the DO as a pending event, and `_reply` wraps it in `keepAliveWhile` — a 30 s alarm heartbeat that "resets the inactivity timer" and prevents *idle eviction* (~70–140 s idle window) for the duration (`index.ts:4790-4879`, `docs/agents/durable-execution.md:50-84`). It does **not** protect against eviction from deploys, resource limits, or alarm timeouts ("keepAlive reduces the chance of eviction. runFiber() makes eviction survivable", `durable-execution.md:46`). When eviction happens anyway, the design intentionally degrades to: chunk buffer in SQLite → orphan finalization on next ACK (§4), and optionally `chatRecovery` fibers to re-drive the generation. So the invariant is: *the stream's durability never depends on the isolate surviving; only its liveness does.*

---

## Design notes for our own transport

Context: our kernel is one DO per agent run; a burst loop samples the model and appends **complete rounds** to storage; observations (`admitted | input | assistant-delta | tool-call | assistant | parked | crashed`) carry a per-run **monotonic `seq` cursor**; callers steer/dispatch via RPC; we already have an observations→`UIMessageChunk` translator.

### (a) Frame types we genuinely need vs. product-specific ones

Their 15 chat frames collapse, for us, into roughly four:

**Genuinely needed (in some form):**
- A **submit** frame (their `use_chat_request`). Drop the `init: {method, body}` HTTP cosplay — it exists only because their transport used to fabricate `Response` objects. Ours is an RPC dispatch that returns `{runId?, seq}` of the admitted input; the `admitted` observation is the ack.
- A **chunk-carrier** frame (their `use_chat_response`). But note *why* theirs is fat (`id`, `done`, `error`, `continuation`, `replay`, `replayComplete`): every one of those booleans patches over the absence of an ordered log. Observations with `seq` + a terminal observation kind subsume `done`/`error`; `replay` vs. live is just `seq <= ackedSeq` vs. new; `continuation` exists because their unit of storage is a mutable UIMessage they must clone-and-append into — our append-only rounds don't mutate history, so the flag disappears. Keep exactly: `{seq, observation}`.
- A **cancel/steer** frame (their `chat_request_cancel`) — we already have RPC for this. Their default of *detach-locally-don't-cancel* is worth copying: closing a browser tab must not kill the burst loop; only an explicit stop RPC should.
- A **transcript-sync** mechanism for late joiners/other tabs. Theirs is full-array snapshot broadcast (`chat_messages`) + single-message upsert (`message_updated`) + clear. With a seq cursor we don't need any of the three as separate types: catch-up is "replay observations from `seq = N`", which the same chunk-carrier frame handles. We may still want a cheap `clear`/epoch-bump signal if runs can be reset in place (or just mint a new run/DO instead).

**Product-specific / compensatory — skip:**
- `stream_resume_request / resuming / resume_ack / resume_none / stream_pending` — the entire five-frame handshake exists because their client has no position to resume *from*: the server must own the decision ("is there a stream? is it yours? has it started yet? did it die with an error while you were away?") and full-replay from zero. With `seq`, resume is one client-initiated message: `subscribe({fromSeq})`. `stream_pending` (#1784 — parking clients during the pre-first-chunk window) vanishes: an `admitted` observation is already in the log before any model chunk exists, so a resuming client sees "turn in flight" from the log itself, not from server-side connection parking.
- `chat_recovering` — an advisory UI hint patching the gap where recovery happens *between* streams and no frame says "working". Our `parked`/`crashed` observations are in-log and strictly more informative.
- `tool_result` / `tool_approval` as bespoke frames — for us these are RPC dispatches that append `input` observations; correlation by `toolCallId` inside the observation payload, like theirs.
- Identity/state/MCP frames — orthogonal to chat; we have our own layers.

**Worth stealing regardless:** the `probeId`-style opaque correlation nonce for any request/response over a socket that can be replaced mid-flight (their #1914 lesson: an uncorrelated response from a stale generation gets misattributed); and stamping the **server-allocated message id into the first chunk** so client-built and server-persisted messages reconcile by id (their #1229/UI-dedup fix) — for us, the observation carries the round id, same effect.

### (b) What they buffer for resumption vs. our seq-cursor replay

Their resumption substrate is a *parallel* store: the chunk tables duplicate the content of the eventual message row, exist only for the replay window, and need their own GC (10 min completed / 60 min abandoned sweeps, alarm re-arming, #1706), orphan finalization, and a "reconstruct message from chunks" accumulator. **Our observation log with `seq` already covers**:

- Chunk replay for reconnecting clients — replay observations from cursor; no separate buffer, no full-replay-from-zero, no client-side "reset accumulator on replayed start" idempotency dance (#1733).
- Mid-stream joiners — same replay; no `pendingResumeConnections` broadcast-exclusion set (their mechanism to prevent live/replay interleaving); with ordered seq delivery a client can trivially merge "replay to seq N, then live > N".
- Orphan detection — their `_isLive` flag distinguishes "stream row exists but reader died". Our equivalent is a `crashed`/`parked` observation appended by the kernel; a resuming client learns the truth from the log, not from a handshake branch.
- Terminal-while-disconnected delivery (#1645, an entire fake-resume subsystem to get an error frame into the client's stream reader) — a `crashed` observation at `seq` is just… replayed.

What our seq replay **does not automatically cover** — check these against the kernel:

1. **Intra-round deltas across restarts.** Their chunk buffer persists *every delta*, so a reconnect mid-generation replays partial text. If our burst loop only appends **complete rounds** to storage and `assistant-delta` observations are ephemeral (fan-out only, not persisted), then a client reconnecting mid-burst replays up to the last complete round but the in-flight round's deltas are gone — acceptable (the round re-emits `assistant` when complete) but decide explicitly whether deltas get seq numbers and persistence or are a volatile overlay on top of durable seq. If deltas are volatile, the translator must make the eventual `assistant` observation *supersede* rendered deltas idempotently (their `continuation`-merge headaches live exactly here).
2. **Retention.** A seq log for a long run grows; they GC aggressively because the buffer is redundant with the message row. Decide our compaction story (e.g. deltas dropped after the round completes; rounds retained; a `fromSeq` floor advertised to clients so a too-old cursor triggers snapshot-then-tail instead of full replay).
3. **Cross-turn client state they persist that isn't transcript**: `cf_ai_chat_request_context` (last client-tool schemas + custom body, needed so a *server-initiated* continuation can re-issue inference with the browser's tool schemas after hibernation). If our HITL parks a run and later resumes it server-side, the parked round must carry whatever caller context is needed to resume — put it in the `parked` observation/round record, not in connection memory.

### (c) workerd gotchas they code around that we must not miss

1. **SQLite row limit (2 MB) + JSON re-escaping inflation.** They cap packed segments at 512 KB raw ("packing serializes bodies into a JSON array, which re-escapes their contents ... generous headroom", `resumable-stream.ts:22-29`), write single large chunks unwrapped, and **silently drop chunks > 1.8 MB from storage while still broadcasting them live** (`:356-377`). Our observation rows need the same discipline: size-guard before insert, and a policy for oversized observations (chunk them or store a reference).
2. **WebSocket send-after-close throws.** Every server send goes through `sendIfOpen` (`chat/connection.ts`), and mid-replay send failure *leaves the stream resumable* rather than corrupting state ("Connection closed mid-replay — leave the stream active so the next reconnect can retry", `resumable-stream.ts:498-502`). Also the specific `TypeError: WebSocket send() after close` catch in RPC (`index.ts:236-254`). Replay loops must treat a failed send as "stop, retry on next connect", never as turn failure.
3. **No backpressure on server→client WS sends** — they don't implement any (broadcast is fire-and-forget `connection.send` per chunk; workerd buffers). The real risk they *do* handle is the storage side (batching). For very chatty delta streams, consider coalescing deltas per flush like their 10-chunk segments.
4. **Idle eviction during long streams (~70–140 s)**: hold an alarm heartbeat while the burst loop runs (`keepAliveWhile`, one alarm slot multiplexed, refcounted). Without it a slow model call gets the DO evicted mid-read. And treat eviction as *expected*: the log (not isolate memory) is the source of truth; on wake, detect the interrupted round and append `crashed`/resume.
5. **Hibernation wipes isolate memory but not attachments/SQLite**: never key protocol progress off in-memory connection sets (their `pendingResumeConnections` works only because clients re-probe on every open). Anything that must survive wake goes in SQLite or the WS attachment; re-derive per-connection wrappers idempotently on first touch after wake (`_ensureConnectionWrapped` pattern). If we store per-connection cursors, the WS attachment is the natural place (survives hibernation with the socket).
6. **Client-side socket replacement** (their PartySocket layer): a socket object can be replaced under the hook (token refresh, options change) — data buffered in a non-open socket is lost forever, and responses to requests sent on a dead socket never arrive. Their fix: queue-until-open, tag each in-flight request with the socket it was transmitted on, reject on that socket's close, retransmit the *handshake* (not the turn) on the replacement (`react.tsx:378-457`, `ws-chat-transport.ts:236-242, 566-581`). Our client must do the same: steer/dispatch RPCs need send-on-open queuing + per-socket-generation rejection; the subscribe-from-seq message is naturally retransmittable.
7. **Duplicate delivery is the norm, dedupe at the edge**: dual `stream_resuming` offers (#1733), provider chunk replays (#1404), StrictMode double-mounts — their client dedupes by request id, probe id, and replayed-`start` resets. With seq, dedupe is one rule — "ignore seq ≤ last applied" — which is exactly why the cursor should be the *only* ordering/identity mechanism, applied uniformly to live and replayed observations.
8. **Compat-date binary quirk**: workerd ≥ 2026-03-17 defaults server-socket `binaryType` to `"blob"`; they pin `"arraybuffer"` defensively (`index.ts:2986-3015`). Irrelevant while we're JSON-text-only; remember it if we ever frame binary.
