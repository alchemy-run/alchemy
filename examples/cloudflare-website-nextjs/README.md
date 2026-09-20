# Cloudflare Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to Cloudflare Workers with
`Cloudflare.Website.Nextjs` — the wrangler-free OpenNext pipeline from
`@alchemy.run/frontend-frameworks/nextjs`. No `wrangler.toml`, no adapter wiring: the
integration runs `next build` through `@opennextjs/cloudflare`, bundles
the resulting worker, and deploys the static assets (including
prerendered pages) alongside it.

- `app/page.jsx` is server-rendered in the Worker on every request and
  reads the `GREETING` binding declared in `alchemy.run.ts` via
  OpenNext's `getCloudflareContext()`.
- `app/api/hello/route.js` is an app-router API route handler.
- Everything under `public/` deploys as static assets.
- Alchemy generates the OpenNext configuration with a read-only static-assets
  cache by default. For writable incremental static regeneration, pass KV
  namespaces through the resource's `isr` property; Alchemy wires the caches
  and revalidation queue automatically.

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

Local development defaults to the production build served under workerd.
Set `dev: { mode: "hmr" }` on the resource to run `next dev` with hot module
replacement and Worker bindings proxied into `getCloudflareContext()`.

## Destroy

```sh
bun run destroy
```
