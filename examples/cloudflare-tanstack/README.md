# Cloudflare Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) app to Cloudflare
Workers with `Cloudflare.Website.Vite` — one Worker serves the frontend
AND a typed backend, bridged by `createClient`.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button calls `bump()` from the browser. Only the framework and cloud
mechanics vary between examples.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument. Its RPC METHODS (`visits`, `bump`) are the API
  surface, backed by the KV namespace through a typed capability binding —
  collected automatically at plan time. No routes, no URL parsing.
- `src/routes/index.tsx` is the UI: the route `loader` server-renders the
  count and the button bumps it from the browser.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` RPC method and
consumed ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The generated worker
entry delivers the queue handler alongside `fetch` — no separate consumer
worker. The UI's queue section sends a message ("Send to queue") and then
polls `processed()` (bounded, once per second) until the count grows, so
the asynchronous catch-up — queue → consumer → KV → UI — is visible in
the `Queue-processed: {count} — last: {last}` line.

## createClient — both forms

`src/lib/backend.ts` builds ONE shared backend client — the same file
layout as the oRPC adapter — picked per world by `createIsomorphicFn`:

```ts
// src/lib/backend.ts
const getBackend = createIsomorphicFn()
  // SSR: VALUE form — direct in-process dispatch, no HTTP; headers
  // resolve per call from TanStack's ambient accessor.
  .server(() =>
    createClient(Backend, {
      headers: () => Object.fromEntries(getRequestHeaders().entries()),
    }),
  )
  // Browser: TYPE-ONLY form — POST /api/__rpc/<method>, zero backend
  // bytes in the client bundle.
  .client(() => createClient<typeof Backend>());

export const backend = getBackend();
```

`src/routes/index.tsx` uses that one client in both worlds: the route
`loader` calls `backend.visits()` (in-process during SSR, over the wire on
client-side navigation), and the Bump button calls `backend.bump()` from
the browser.

## Mechanics

- The SSR seam is the shared isomorphic client in `src/lib/backend.ts` —
  routes never import the backend value directly.
- `main: import.meta.url` anchors `src/backend.ts`: the engine imports it
  for plan-time binding collection and the generated worker entry
  re-imports it inside the vite graph.

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
