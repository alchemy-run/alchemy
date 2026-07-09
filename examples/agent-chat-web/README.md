# agent-chat-web

A minimal web chat over a locally running alchemy agent — stock
[`useChat`](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot) on the client,
the alchemy serving tier (`alchemy/AI` → `Api.agentApi()`) on the
server. No custom transport: the server speaks the AI SDK v5 UI
message stream verbatim.

The demo agent is a dice-parlor croupier with two tools:

- `roll_dice` — an ordinary kernel-executed tool (renders as a tool
  card while the run streams)
- `request_approval` — parks the run on the Ask protocol; the UI shows
  an approval card and answers it via `POST /api/asks/:id`

## Run it

```sh
# 1. the agent server (port 8787)
ANTHROPIC_API_KEY=sk-… bun run server

# 2. the web app (Vite proxies /api and /v1 to the server)
bun run dev
```

Try: `wager 10 coins on a d20` (tool call), then
`wager 100 coins on a d6` (approval card — the model must ask first).

## What to look at

- [server.ts](./server.ts) — the whole backend: an `AI.Agent` term,
  two tool Layers, `ChatSessions`, `agentApi()`, a Bun HTTP server.
- [src/App.tsx](./src/App.tsx) — stock `useChat` plus rendering for
  `dynamic-tool` and `data-ask` parts.
- `GET localhost:8787/v1/stream/Croupier?offset=0` — the durable
  trace window behind the same conversation.
