# Streaming: the kernel event log and the UI edge

How a running kernel's activity reaches UIs — designed from a survey of
nine harnesses (Vercel AI SDK, Effect AI, OpenCode, Pi, Mastra, Codex,
eve, flue, grok-build). Every one of them independently converged on
the same architecture, which we adopt:

```
kernel ──emit──▶ per-run EVENT LOG (canonical, seq'd, durable-ready)
                     │
                     ├── snapshot: reduce log → UIMessage[] (GET)
                     └── tail: PubSub → edge adapter → UIMessageChunk SSE (POST /api/chat)
```

## The five convergent rules

1. **The kernel speaks its own vocabulary, never the UI's.** Codex has
   `EventMsg`, OpenCode has bus events, flue has `FlueEvent`, Mastra has
   `ChunkType` — and ALL of them translate to the AI SDK's
   `UIMessageChunk` (or their own UI projection) at the HTTP edge only.
   Ours is `KernelObservation` (AI/Observer.ts): the kernel's facts,
   JSON-serializable, with the AI SDK left out of the kernel entirely.

2. **Per-run streams with correlation ids on every event.** One stream
   per run (`term` + `key`), Codex-style ids on every event (`tick` as
   turn id, `toolCallId`), and a monotonically increasing `seq` per run
   so consumers can dedupe and resume. Subagent activity is its own
   run's stream, linked by id — never text merged into the parent.

3. **Snapshot + tail, never tail-only.** Every surveyed UI loads state
   first (OpenCode `session.messages`, Pi `get_messages`, flue
   `view=history`, eve `startIndex`) and then follows live events,
   reconciling by id/seq. Our edge: `GET /api/chats/:id/messages`
   returns `UIMessage[]` reduced from the log; the live stream carries
   `seq` so a reconnecting client resumes from where its snapshot ended.

4. **Lifecycle pairs, not bare deltas.** start/delta/end for text and
   tool input; input-available/output-available for tools. Boundaries
   are what make catch-up and UIMessage reconstruction possible;
   deltas alone cannot be replayed into state.

5. **Translate at the edge with the AI SDK's own vocabulary.** The wire
   is exactly `UIMessageChunk` over SSE (`data: {json}\n\n`, terminated
   `data: [DONE]\n\n`, header `x-vercel-ai-ui-message-stream: v1`) so
   `useChat` + AI Elements consume the org with zero client adapters.

## The mapping (kernel → AI SDK)

One kernel RUN = one chat. One BURST of ticks (admit/steer →
quiescence) = one assistant `UIMessage`. One TICK = one step:

```
start
  (start-step
     text-start / text-delta / text-end          ← assistant text
     tool-input-available {toolCallId,toolName}  ← tool call
     tool-output-available {toolCallId,output}   ← handler result
   finish-step) × ticks
finish                                            ← quiescence / settle
data: [DONE]
```

Tool calls render as `dynamic-tool` parts (tool names are dynamic).
`sendMessage` on a desk chat is honest: the text is posted as a GitHub
comment — the world's real door — which steers the desk through the
same event pipeline as any other world event.

## Staging

- **Stage 1 (now): turn-granular streaming.** The kernel keeps
  `generateText`; each sampling emits one `assistant` observation
  (full text + tool calls) and `tool-result`s. The edge emits the SAME
  protocol — text arrives as one start/delta/end triple per tick.
  Every consumer works; granularity is per-tick (~1-3s).
- **Stage 2: token-granular.** `KernelMemory.step` switches to
  `LanguageModel.streamText` and forwards Effect's stream parts
  (`text-delta`, `tool-params-*`) into observations as they arrive.
  Protocol unchanged — only `text-delta` frequency changes. Effect's
  guarantee (tool results before `finish`) maps cleanly onto
  `finish-step`.
- **Stage 3: durability.** The per-run log gains a persistent store
  (OpenCode's `(aggregate, seq)` table / flue's Durable Streams shape)
  so catch-up survives process restarts — the same restart gap the
  in-memory kernel already has for runs.

## Why observations don't block

Emission is fire-and-forget (`Effect.ignore`) through the optional
`KernelObserver` service — the same seam pattern as `WireMode`. A slow
or broken observer can never slow a run; a missing observer costs
nothing.
