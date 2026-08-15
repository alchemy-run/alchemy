# Cloudflare Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to Cloudflare Workers with
`Cloudflare.Website.Nextjs` — the wrangler-free OpenNext pipeline from
`@alchemy.run/frontend-frameworks/nextjs`. No `wrangler.toml`, no adapter
wiring: the integration runs `next build` through
`@opennextjs/cloudflare`, bundles the resulting worker, and deploys the
static assets (including prerendered pages) alongside it.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button bumps it from the browser through a Next server action. Only the
framework and cloud mechanics vary between examples.

- `app/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the Next.js app and a typed
  backend. The program's RPC METHODS (`visits`, `bump`) are the API
  surface for trusted server code, backed by the KV namespace through a
  typed capability binding — collected automatically at plan time.
- `app/page.tsx` (async server component) server-renders the count;
  `app/actions.ts` (`"use server"`) exposes the mutations as server
  actions; `app/visits-card.tsx` (`"use client"`) bumps optimistically
  from the browser. The UI is Tailwind with hand-copied shadcn-style
  components (`app/components/ui/`).

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` RPC method and
consumed ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The entry takeover
wraps the OpenNext worker artifact so the queue handler is delivered
alongside `fetch` — no separate consumer worker. (Queue delivery is
prod-only for Next: `alchemy dev` serves the frontend, but consumed
batches only flow in a real deploy.) The UI's queue card
(`app/queue-card.tsx`) sends a message ("Send to queue") through the
`enqueueJob` server action and then polls `getProcessed` (bounded, once
per second) until the count grows, so the asynchronous catch-up — queue
→ consumer → KV → UI — is visible in the
`Queue-processed: {count} — last: {last}` line.

## createClient is server-only — server actions are the public API

Schema-less RPC is for trusted callers: `createClient(Backend)` (the
value form) dispatches backend methods in-process and never leaves the
server. The browser reaches the backend through Next's own transport —
the server actions in `app/actions.ts`:

```tsx
// app/page.tsx (SSR): the value form — direct in-process dispatch
import Backend from "./backend";
const backend = createClient(Backend);
const visits = await backend.visits();
```

```ts
// app/actions.ts ("use server"): the actions ARE the public API; inside
// them the same value form runs — trusted server code
const backend = createClient(Backend, { headers });
export async function bumpVisits(): Promise<number> {
  return backend.bump();
}
```

```tsx
// app/visits-card.tsx ("use client"): imports ONLY ./actions — zero
// backend bytes in the client bundle
import { bumpVisits } from "./actions";
setBumped(await bumpVisits());
```

## Mechanics

- The takeover is automatic (no route.ts mount): the generated entry
  delivers the program's platform handlers (the queue consumer)
  alongside `fetch`; every HTTP path (including Next's own `/api/hello`
  route handler) stays Next's.
- `app/api/hello/route.ts` is an app-router API route handler.
- Everything under `public/` deploys as static assets.
- `open-next.config.ts` selects the read-only static-assets incremental
  cache: ISR pages serve their prerendered payloads; revalidation writes
  are a no-op (v1 limitation — no KV/R2/D1-backed cache yet).
- The integration packages must be installed in the project (the source
  provider is loaded dynamically at deploy time):

  ```sh
  bun add -d @alchemy.run/frontend-frameworks @opennextjs/cloudflare
  ```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the OpenNext build entirely on subsequent
deploys — the input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

Local dev is v1 preview parity: the built worker served under workerd
via `@alchemy.run/cloudflare-runtime/core`. No HMR yet.

## Destroy

```sh
bun run destroy
```
