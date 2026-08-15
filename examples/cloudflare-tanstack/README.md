# Cloudflare Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) app to Cloudflare
Workers with `Cloudflare.Website.Vite` — one Worker serves the frontend
AND a typed backend, bridged by TanStack server functions and
`createClient`.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button bumps it from the browser. Only the framework and cloud mechanics
vary between examples.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument. Its RPC METHODS (`visits`, `bump`) are the backend
  surface, backed by the KV namespace through a typed capability binding —
  collected automatically at plan time. No routes, no URL parsing.
- `src/server/visits.ts` wraps those methods in TanStack server functions
  — the site's public API.
- `src/routes/index.tsx` is the UI: the route `loader` server-renders the
  count and shadcn-style cards (`src/components/`) drive the demo from
  the browser.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` RPC method and
consumed ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The generated worker
entry delivers the queue handler alongside `fetch` — no separate consumer
worker. The UI's queue card sends a message ("Send to queue") and then
polls `getProcessed` (bounded, once per second) until the count grows, so
the asynchronous catch-up — queue → consumer → KV → UI — is visible in
the `Queue-processed: {count} — last: {last}` line.

## Server functions are the public API

Schema-less RPC is for trusted callers only — there is no public HTTP
wire. The browser reaches the backend exclusively through TanStack server
functions, which dispatch the backend methods in-process via the VALUE
form of `createClient`:

```ts
// src/server/visits.ts
import { createServerFn } from "@tanstack/react-start";
import { backend } from "../lib/backend.ts";

export const bumpVisits = createServerFn({ method: "POST" }).handler(() =>
  backend.bump(),
);
```

`src/lib/backend.ts` builds the ONE shared server-side client — headers
resolve per call from TanStack's ambient accessor, so backend methods can
self-authorize from the caller's cookies:

```ts
// src/lib/backend.ts
export const backend: RpcClient<typeof Backend> = createClient(Backend, {
  headers: getRequestHeaders,
});
```

The route `loader` calls the same server functions — in-process during
SSR, over Start's transport on client-side navigation — and the client
components (`src/components/*-card.tsx`) import ONLY
`src/server/visits.ts`, never the backend module.

## Mechanics

- The SSR seam is the shared value-form client in `src/lib/backend.ts` —
  only server functions import it; zero backend bytes reach the browser
  bundle.
- `main: import.meta.url` anchors `src/backend.ts`: the engine imports it
  for plan-time binding collection and the generated worker entry
  re-imports it inside the vite graph.
- The UI is Tailwind + hand-copied shadcn-style components
  (`src/components/ui/`) — no component CLI, no `<script>` tags.

## Deploy

```sh
bun run deploy
```

## Dev

```sh
bun run dev
```

## Destroy

```sh
bun run destroy
```
