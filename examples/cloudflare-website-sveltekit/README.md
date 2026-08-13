# Cloudflare Website: SvelteKit

Deploys a SvelteKit app to Cloudflare Workers with `Cloudflare.Website.SvelteKit` — no `svelte.config.js`, no `@sveltejs/adapter-cloudflare`, no Wrangler.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory Cloudflare adapter, re-bundles the server output for workerd, and deploys client assets + prerendered pages as Worker static assets. Values passed via `env` are exposed to server routes through `platform.env`.

The Website class lives in `src/backend.ts` and takes an Effect program as its third argument: ONE Worker serves the SvelteKit app and a typed backend API. The program's RPC METHODS (`visit`, `visits`) are the API surface, backed by a KV namespace through a typed capability binding — collected automatically at plan time.

```ts
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    return {
      visit: () =>
        Effect.gen(function* () {
          const count = Number((yield* visits.get("count")) ?? "0") + 1;
          yield* visits.put("count", String(count));
          return count;
        }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
```

`createClient` bridges both worlds:

```ts
// src/routes/+page.server.ts (SSR seam): VALUE form — direct in-process
// dispatch inside the Worker, no HTTP hop
import Backend from "../backend.ts";
export const load = async ({ request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return { visits: await backend.visit() };
};
```

```svelte
<!-- src/routes/+page.svelte (browser): TYPE-ONLY form — POST
     /api/__rpc/<method>, zero backend bytes in the client bundle -->
<script lang="ts">
  import { createClient } from "alchemy/client";
  import type Backend from "../backend.ts";
  const backend = createClient<typeof Backend>();
</script>
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
