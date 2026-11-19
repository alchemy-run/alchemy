# E2B async program example

A plain Node handler, with no Effect runtime, baked into an E2B template and served from one long-lived sandbox.

- [`src/Greeter.ts`](./src/Greeter.ts) — `E2B.Template` called as a function with `main` pointing at the handler file, and `E2B.InferEnv` typing its `env`.
- [`src/server.ts`](./src/server.ts) — the handler, reading `GREETING` from its environment.
- [`alchemy.run.ts`](./alchemy.run.ts) — builds the template and declares the `E2B.Sandbox` that serves it.

## Commands

```sh
pnpm alchemy profile edit --add E2B   # once: log Alchemy in to E2B
pnpm --filter e2b-program-async deploy
pnpm --filter e2b-program-async test
pnpm --filter e2b-program-async destroy
```
