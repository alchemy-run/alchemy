# Cloudflare Website: Astro

Deploys an [Astro](https://astro.build) site to Cloudflare Workers with
`Cloudflare.Website.Astro` — no `astro.config.*`, adapter setup, or
Wrangler configuration.

- `src/backend.ts` declares the Website class with an Effect program as its
  third argument: ONE Worker serves the Astro frontend and an
  Effect-native API. The program's `fetch` owns `/api/*` and uses a KV
  namespace through a typed capability binding — the binding is
  collected automatically at plan time, no extra wiring in
  `alchemy.run.ts`.
- `src/pages/index.astro` is server-rendered in the Worker on every
  request and calls `/api/visits` from the browser to show the
  KV-backed visit counter.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served as a static asset.
- Everything under `public/` deploys as static assets.

The integration package must be installed in the project (it is loaded
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
