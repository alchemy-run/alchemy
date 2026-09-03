# Cloudflare Website: vinext

Deploys a [vinext](https://vinext.dev) App Router app to Cloudflare
Workers with `Cloudflare.Website.Vinext` — Vite plus the Next.js API,
KV-backed ISR, no `wrangler.jsonc`. This is not the OpenNext path used
by `Cloudflare.Website.Nextjs`.

Setup, bindings Alchemy owns, and the prerender → KV seed path are
documented under [vinext on Cloudflare](https://alchemy.run/cloudflare/frontend/vinext/).

- Home is SSR and reads `GREETING`. `/static` is prerendered. `/isr`
  is ISR. `/use-cache` is a dynamic page plus `"use cache"`.
- `/api/*` is an App Router catch-all. Notes go to a sibling Worker
  over the `BACKEND` service binding; `/api/kv` uses the site `KV`.
- `proxy.ts` returns 403 for `/admin`.
- Everything under `public/` deploys as static assets.

```ts
export class Vinext extends Cloudflare.Website.Vinext<Vinext>()("Vinext", {
  env: {
    GREETING: "Hello from vinext on Cloudflare!",
    BACKEND: Backend,
    KV,
  },
});
```
