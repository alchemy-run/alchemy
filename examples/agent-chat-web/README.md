# agent-chat-web — the org workspace

A Discord/Slack-shaped workspace over locally running alchemy
processes (designs/ai/org-chat.md). The app's structure is **derived
from the term graph**: the sidebar is `GET /api/topology` — channels
grouped by their user-defined process kind, agents as DM targets —
nothing is configured.

- **`Channel` is a userland kind** ([src/org.ts](./src/org.ts)):
  `AI.Process("Channel", { charter, meta })` scaffolds the
  room-simulator prose, the `AI.until` halt, and the budget around
  each instance's template. `#engineering` (Sage + Scout) and
  `#support` (Helper) are instances.
- **A Post is a run**: posting in a channel admits a work item to the
  channel process's ring; the charter decides who responds (parallel
  background delegations for hard questions), relays member replies
  into the thread via the `post_reply` tool (rendered as authored
  bubbles), and resolves with a summary.
- **Replies join the Post's thread**: the thread is the Post's
  conversation; replies re-admit with full history.
- **Agents are DMs**: clicking an agent opens the 1:1 conversation
  with that agent's own ring (`dm:Sage/main`).

## Run it

```sh
# 1. the org server (port 8787)
ANTHROPIC_API_KEY=sk-… bun run server

# 2. the web app (Vite proxies /api and /v1 to the server)
bun run dev
```

Try, in `#engineering`: *"Should we use SQLite or Postgres for a small
internal tool? Need a quick take and a considered one."* — the channel
fans out to Scout and Sage in parallel, relays both replies, and
resolves the Post. Toggle **trace** to watch the kernel facts flow.

## What to look at

- [src/org.ts](./src/org.ts) — the whole org: the `Channel` kind, two
  channels, three agents, tool physics.
- [src/server.ts](./src/server.ts) — rings interpreted per term,
  conversations routed by target prefix, topology served.
- [src/App.tsx](./src/App.tsx) — the workspace shell: derived sidebar,
  Posts, threads, DMs, authored reply bubbles.
