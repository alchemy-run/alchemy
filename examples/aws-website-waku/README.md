# AWS Website: Waku

Deploys an **effectful** [Waku](https://waku.gg) app to AWS with `AWS.Website.Waku` — no `waku.config.ts` adapter, no CDK: ONE streaming Lambda serves the Waku frontend AND a typed Effect backend, with the queue consumer dispatching on the SAME function (single-handler delivery, `Serve/DESIGN.md` AWS phase 4).

The resource builds the app with waku's own Vite pipeline and a wrangler-free in-memory AWS adapter. With an Effect program as the third argument, the generated Lambda entry is `makeFrameworkFunctionHandler({ site, fetch })` from `alchemy/AWS/Serve`: waku's fetch (with the mount middleware inside it) serves ALL HTTP verbatim, and SQS batches dispatch through the program's registered consumer inside the one `streamifyResponse` wrap.

HTTP composition is YOURS, in waku's own idiom: `src/middleware/mount.ts` (waku's framework hook) mounts the program via `alchemy/Serve` and runs identically under `waku dev`, `alchemy dev`, and on the deployed Lambda. On AWS `site.fetch(request)` takes no env/ctx — env resolves from `process.env` and the request scope settles inline (Lambda semantics).

## The app

The shared MaxSite fixture program (minus DOs/Workflows, which AWS has no analogue for):

- `src/backend.ts` — the Website class: an Effect `fetch` API under `/api/*` (queue producer, streaming route, request-scope finalizer, DynamoDB observability), the SQS consumer on the same Lambda, and RPC methods for the value-form `createClient`
- `src/middleware/mount.ts` — the mount file: `/healthz` short-circuit, an `x-admin-key` gate, then `site.fetch ?? next()`
- `src/lib/backend.ts` — the module-scope value-form `createClient`, used by the RSC page during SSR
- `src/pages/index.tsx` — dynamic RSC page: renders the backend's counters through the value-form client
- `src/pages/about.tsx` — static page, prerendered at build time and served from S3
- `src/components/Counter.tsx` — a `"use client"` island hydrated into the server-rendered page

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # waku's Vite dev server (HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/waku` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- Read env via `getEnv` from `waku` (as in `src/pages/index.tsx`) — it is backed by the Lambda's `process.env` at request time and keeps page modules portable across deploy targets.
