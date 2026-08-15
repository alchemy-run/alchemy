# Cloudflare Website: Astro

Deploys an [Astro](https://astro.build) site to Cloudflare Workers with
`Cloudflare.Website.Astro` — no `astro.config.*` adapter setup or
Wrangler configuration.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button bumps it from the browser. Only the framework and cloud mechanics
vary between examples.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the Astro frontend and a typed
  backend API. The program's RPC METHODS (`visits`, `bump`) are the API
  surface, backed by the KV namespace through a typed capability binding —
  collected automatically at plan time, no extra wiring in
  `alchemy.run.ts`.
- `src/pages/index.astro` server-renders the initial state and mounts the
  React island.
- `src/components/VisitsCard.tsx` is the UI — a React island styled with
  Tailwind and hand-copied shadcn-style components
  (`src/components/ui/`). It bumps optimistically and polls the queue
  state through Astro Actions.
- `src/actions/index.ts` is the public API: Astro Actions
  (`POST /_actions/<name>`) validate input with zod and call the backend
  in-process.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` RPC method and
consumed ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The entry takeover
wraps the vendored Astro worker entry so the queue handler is delivered
alongside `fetch` — no separate consumer worker. The island's queue card
sends a message ("Send to queue") and then polls the `processed` action
(bounded, once per second) until the count grows, so the asynchronous
catch-up — queue → consumer → KV → UI — is visible in the
`Queue-processed: {count} — last: {last}` line.

## The API surface: Astro Actions over the value form

Schema-less RPC is for trusted callers only — there is no public RPC
wire. Astro Actions are the framework's own transport, and inside them
the backend is called through the in-process value form:

```ts
// src/actions/index.ts — the PUBLIC API (framework-validated)
import { defineAction, type ActionAPIContext } from "astro:actions";
import { createClient } from "alchemy/Client";
import { z } from "astro/zod";
import Backend from "../backend.ts";

const backend = (ctx: ActionAPIContext) =>
  createClient(Backend, { headers: ctx.request.headers });

export const server = {
  bump: defineAction({ handler: (_input, ctx) => backend(ctx).bump() }),
  enqueue: defineAction({
    input: z.object({ message: z.string().min(1).max(256) }),
    handler: ({ message }, ctx) => backend(ctx).enqueue(message),
  }),
};
```

```ts
// src/pages/index.astro frontmatter (SSR, non-prerendered): the same
// value form — direct in-process dispatch, no HTTP hop
import Backend from "../backend.ts";
const backend = createClient(Backend, { headers: Astro.request.headers });
const visits = await backend.visits();
```

```tsx
// src/components/VisitsCard.tsx (browser): the framework's typed client
import { actions } from "astro:actions";
const count = await actions.bump.orThrow();
```

## Mechanics

- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served as a static asset.
- Everything under `public/` deploys as static assets.
- The integration package must be installed in the project (it is loaded
  dynamically at deploy time):

  ```sh
  bun add -d @alchemy.run/frontend-frameworks
  ```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the Astro build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```
