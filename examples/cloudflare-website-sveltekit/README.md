# Cloudflare Website: SvelteKit

Deploys a SvelteKit app to Cloudflare Workers with `Cloudflare.Website.SvelteKit` — no `svelte.config.js`, no `@sveltejs/adapter-cloudflare`, no Wrangler.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory Cloudflare adapter, re-bundles the server output for workerd, and deploys client assets + prerendered pages as Worker static assets. Values passed via `env` are exposed to server routes through `platform.env`.

The Website class lives in `src/backend.ts` and takes an Effect program as its third argument: ONE Worker serves the SvelteKit app and an Effect-native API. The program's `fetch` owns `/api/*` (the default `server.routes`) and uses a KV namespace through a typed capability binding — collected automatically at plan time. Inside the routes the program is authoritative (even its 404s); outside them kit serves and the program is never invoked.

```ts
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
  { main: import.meta.url, env: { GREETING: "Hello from alchemy" } },
  Effect.gen(function* () {
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    return {
      fetch: Effect.gen(function* () {
        // ... /api/visits handled here; unknown /api/* paths get the
        // program's own 404
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the Worker's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, `platform.env` carries the Worker's real Cloudflare bindings (KV, R2, D1, ...) served by the cloudflare-runtime platform proxy, with literal `env` values (strings and secrets) overlaid.
