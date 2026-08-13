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
button calls `bump()` from the browser. Only the framework and cloud
mechanics vary between examples.

- `app/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the Next.js app and a typed
  backend API. The program's RPC METHODS (`visits`, `bump`) are the API
  surface, backed by the KV namespace through a typed capability binding —
  collected automatically at plan time.
- `app/page.tsx` (async server component) server-renders the count;
  `app/visits.tsx` (`"use client"`) bumps it from the browser.

## createClient — both forms

```tsx
// app/page.tsx (SSR): VALUE form — direct in-process dispatch, no HTTP hop
import Backend from "./backend";
const backend = createClient(Backend);
const visits = await backend.visits();
```

```tsx
// app/visits.tsx ("use client"): TYPE-ONLY form — POST
// /api/__rpc/<method>, zero backend bytes in the client bundle
import { createClient } from "alchemy/client";
import type Backend from "./backend";
const backend = createClient<typeof Backend>();
await backend.bump();
```

## Mechanics

- The takeover is automatic (no route.ts mount): the generated entry
  serves the RPC dispatch at `/api/__rpc/*` first; every other path
  (including Next's own `/api/hello` route handler) stays Next's.
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
