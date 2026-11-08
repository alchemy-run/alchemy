# Boat agent sandbox example

A Cloudflare Worker that runs untrusted code in Boat sandboxes.

- [`src/Api.ts`](./src/Api.ts) — `POST /run` runs a script in a fresh sandbox, deleted when the request ends. `/users/<user>/files/<file>` keeps a sandbox per user, found by label and resumed on the next request.

## Commands

```sh
pnpm alchemy profile edit --add Boat   # once: sign Alchemy in to Boat
pnpm --filter boat-agent-sandbox deploy
pnpm --filter boat-agent-sandbox test
pnpm --filter boat-agent-sandbox destroy
```
