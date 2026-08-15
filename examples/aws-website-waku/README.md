# AWS Website: Waku

Deploys a [Waku](https://waku.gg) app to AWS with `AWS.Website.Waku` — no `waku.config.ts` adapter, no CDK.

The resource builds the app with waku's own Vite pipeline and a wrangler-free in-memory AWS adapter: the RSC server bundle deploys on a streaming Lambda Function URL, and the client output (including SSG-prerendered pages and the RSC payloads) deploys to S3 behind CloudFront. Values passed via `server.environment` are readable in server components through waku's `getEnv`.

```ts
const site = yield* AWS.Website.Waku("WakuSite", {
  server: {
    environment: {
      GREETING: "Hello from alchemy",
    },
  },
});
```

## The app

A minimal Waku site — a framework showcase, not a backend demo (no bindings beyond `server.environment`):

- `src/pages/index.tsx` — dynamic RSC page, rendered by the Lambda on every request; reads `GREETING` via `getEnv`
- `src/pages/about.tsx` — static page, prerendered at build time and served from S3
- `src/components/Counter.tsx` — a `"use client"` island hydrated into the server-rendered page
- `src/components/ui/` — hand-copied shadcn-style components (`button.tsx`, `card.tsx` + the `cn` util) styled with Tailwind CSS v4

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
