# Cloudflare Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to Cloudflare Workers with
`Cloudflare.Website.Nextjs` — the wrangler-free OpenNext pipeline from
`@alchemy.run/frontend-frameworks/nextjs`. No `wrangler.toml`, no adapter wiring: the
integration runs `next build` through `@opennextjs/cloudflare`, bundles
the resulting worker, and deploys the static assets (including
prerendered pages) alongside it.

- `src/backend.ts` declares the Website class with an Effect program as its
  third argument: ONE Worker serves the Next.js app and an Effect-native
  API. The program's `fetch` owns `server.routes`
  (`["/api/*", "!/api/hello"]` here) and uses a KV namespace through a
  typed capability binding — collected automatically at plan time. The
  takeover is automatic (no route.ts mount); inside the routes the
  program is authoritative (even its 404s), while the `!/api/hello`
  exclusion statically hands that path back to Next's own route handler.
- `app/page.jsx` is server-rendered in the Worker on every request,
  reads the `GREETING` binding via OpenNext's `getCloudflareContext()`,
  and calls `/api/visits` from the browser to show the KV-backed visit
  counter.
- `app/api/hello/route.js` is an app-router API route handler.
- Everything under `public/` deploys as static assets.
- `open-next.config.ts` selects the read-only static-assets incremental
  cache: ISR pages serve their prerendered payloads; revalidation writes
  are a no-op (v1 limitation — no KV/R2/D1-backed cache yet).

The integration packages must be installed in the project (the source
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
