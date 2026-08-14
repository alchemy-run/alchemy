# Cloudflare Website: Astro

Deploys an [Astro](https://astro.build) site to Cloudflare Workers with
`Cloudflare.Website.Astro` — no `astro.config.*`, adapter setup, or
Wrangler configuration.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button calls `bump()` from the browser. Only the framework and cloud
mechanics vary between examples.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the Astro frontend and a typed
  backend API. The program's RPC METHODS (`visits`, `bump`) are the API
  surface, backed by the KV namespace through a typed capability binding —
  collected automatically at plan time, no extra wiring in
  `alchemy.run.ts`.
- `src/pages/index.astro` is the UI: the frontmatter server-renders the
  count and the inline `<script>` bumps it from the browser.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` RPC method and
consumed ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The entry takeover
wraps the vendored Astro worker entry so the queue handler is delivered
alongside `fetch` — no separate consumer worker. The UI's queue section
sends a message ("Send to queue") and then polls `processed()` (bounded,
once per second) until the count grows, so the asynchronous catch-up —
queue → consumer → KV → UI — is visible in the
`Queue-processed: {count} — last: {last}` line.

## createClient — both forms

```ts
// src/pages/index.astro frontmatter (SSR, non-prerendered): VALUE form —
// direct in-process dispatch, no HTTP hop
import Backend from "../backend";
const backend = createClient(Backend, { headers: Astro.request.headers });
const visits = await backend.visits();
```

```ts
// src/pages/index.astro <script> (browser): TYPE-ONLY form —
// POST /api/__rpc/<method>, zero backend bytes in the client bundle
import { createClient } from "alchemy/client";
import type Backend from "../backend";
const backend = createClient<typeof Backend>();
await backend.bump();
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
