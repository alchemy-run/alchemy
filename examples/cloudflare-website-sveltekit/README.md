# Cloudflare Website: SvelteKit

Deploys a SvelteKit app to Cloudflare Workers with `Cloudflare.Website.SvelteKit` — no `svelte.config.js`, no `@sveltejs/adapter-cloudflare`, no Wrangler.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button calls `bump()` from the browser. Only the framework and cloud
mechanics vary between examples.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the SvelteKit app and a typed
  backend API. The program's RPC METHODS (`visits`, `bump`) are the API
  surface, backed by the KV namespace through a typed capability binding —
  collected automatically at plan time.
- `src/routes/+page.server.ts` server-renders the count; the button in
  `src/routes/+page.svelte` bumps it from the browser.

## createClient — both forms

```ts
// src/routes/+page.server.ts (SSR seam): VALUE form — direct in-process
// dispatch inside the Worker, no HTTP hop
import Backend from "../backend.ts";
export const load = async ({ request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return { visits: await backend.visits() };
};
```

```svelte
<!-- src/routes/+page.svelte (browser): TYPE-ONLY form — POST
     /api/__rpc/<method>, zero backend bytes in the client bundle -->
<script lang="ts">
  import { createClient } from "alchemy/client";
  import type Backend from "../backend.ts";
  const backend = createClient<typeof Backend>();
  // await backend.bump()
</script>
```

## Mechanics

- The resource builds the app with SvelteKit's own Vite pipeline and a
  wrangler-free in-memory Cloudflare adapter, re-bundles the server output
  for workerd, and deploys client assets + prerendered pages as Worker
  static assets. Values passed via `env` are exposed to server routes
  through `platform.env`.
- `@alchemy.run/frontend-frameworks` must be installed in the project —
  the Worker's source provider is loaded from its `/sveltekit` export at
  deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree
  is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, `platform.env` carries the Worker's real Cloudflare
  bindings (KV, R2, D1, ...) served by the cloudflare-runtime platform
  proxy, with literal `env` values (strings and secrets) overlaid.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```
