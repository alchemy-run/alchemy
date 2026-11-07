# E2B program example

An Effect HTTP program baked into an E2B template and served from one long-lived sandbox.

- [`src/Api.ts`](./src/Api.ts) — `E2B.Template` in its class form: the program counts visits in memory.
- [`alchemy.run.ts`](./alchemy.run.ts) — builds the template and declares an `E2B.Sandbox` that runs it. The sandbox pauses when idle and a request to its URL resumes it, memory included. A new build of the program replaces the sandbox.

## Commands

```sh
pnpm alchemy profile edit --add E2B   # once: log Alchemy in to E2B
pnpm --filter e2b-program deploy
pnpm --filter e2b-program test
pnpm --filter e2b-program destroy
```
