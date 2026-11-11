# Boat agent sandbox example

Build a snapshot at deploy time, and start sandboxes from it while the app runs.

- [`src/Golden.ts`](./src/Golden.ts) — built at deploy: a snapshot with a repository cloned and pnpm installed.
- [`src/Api.ts`](./src/Api.ts) — starts sandboxes from Golden while it runs. `POST /run` runs a command in a fresh one, deleted when the request ends. `/users/<user>/files/<file>` keeps a sandbox per user, found by label and resumed on the next request.

## Commands

```sh
pnpm alchemy profile edit --add Boat   # once: sign Alchemy in to Boat
pnpm --filter boat-agent-sandbox deploy
pnpm --filter boat-agent-sandbox test
pnpm --filter boat-agent-sandbox destroy
```
