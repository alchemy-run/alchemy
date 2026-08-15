# Cloudflare Website: SvelteKit

Deploys a SvelteKit app to Cloudflare Workers with `Cloudflare.Website.SvelteKit` — no `svelte.config.js`, no `@sveltejs/adapter-cloudflare`, no Wrangler.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two methods on the backend
program — `visits()` reads the count and `bump()` increments it. The page
server-renders `Server-rendered visits: {n}` and a "Bump visits" button
bumps it through a SvelteKit form action. Only the framework and cloud
mechanics vary between examples.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the SvelteKit app and a typed
  backend. The program's methods (`visits`, `bump`, ...) are the API
  surface for trusted server code, backed by the KV namespace through a
  typed capability binding — collected automatically at plan time.
- `src/routes/+page.server.ts` is the public surface: `load`
  server-renders the counts, and the `bump`/`enqueue` form actions are
  what the browser submits to (progressively enhanced with
  `use:enhance`).
- `src/routes/+page.svelte` renders shadcn-style components
  (`src/lib/components/ui/`) with an optimistic bump and bounded
  queue-catch-up polling — no backend import anywhere in client code.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` method and consumed
ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The generated Worker
shim delivers the queue handler alongside `fetch` — no separate consumer
worker. In the UI, the queue form enqueues a message and then polls the
`GET /api/processed` route (bounded, once per second) until the count
grows, so the asynchronous catch-up — queue → consumer → KV → UI — is
visible in the `Queue-processed: {count} — last: {last}` line.

## createClient — trusted server code only

Schema-less RPC never crosses a trust boundary: there is no public wire.
SvelteKit's server files import the backend **as a value** and dispatch
in-process:

```ts
// src/routes/+page.server.ts — load + form actions ARE the public API
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export const load = async ({ request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return { visits: await backend.visits() };
};

export const actions = {
  bump: async ({ request }) => {
    const backend = createClient(Backend, { headers: request.headers });
    return { bumped: await backend.bump() };
  },
};
```

```ts
// src/routes/api/processed/+server.ts — a JSON route for client polling
export const GET = async ({ request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return json(await backend.processed());
};
```

The browser only ever submits forms and fetches routes — zero backend
bytes in the client bundle, and the framework transports are the only
public API.

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
