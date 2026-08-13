# Cloudflare Website: Nuxt

Deploys a Nuxt app to Cloudflare Workers with `Cloudflare.Website.Nuxt` — no `nitro.preset` edits, no Wrangler.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `cloudflare_module` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle as the Worker, and serves client assets + prerendered pages as Worker static assets. Values passed via `env` are exposed to server routes and SSR through `event.context.cloudflare.env`.

The Website class lives in `server/backend.ts` and takes an Effect program as its third argument: ONE Worker serves the Nuxt app and a typed backend API. The program's RPC METHODS (`visit`, `visits`) are the API surface, backed by a KV namespace through a typed capability binding — collected automatically at plan time. The program also keeps a `fetch` owning `server.routes` (`["/api/*", "!/api/hello"]`) to demonstrate route ownership: inside the claim the program is authoritative (even its 404s); the `!/api/hello` exclusion statically hands that path back to nitro, so the app's own route keeps answering.

```ts
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  {
    main: import.meta.url,
    server: { routes: ["/api/*", "!/api/hello"] },
  },
  Effect.gen(function* () {
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    return {
      fetch: HttpServerResponse.json(
        { error: "unknown effect route" },
        { status: 404 },
      ),
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

`createClient` bridges both worlds in `app/pages/index.vue`:

```ts
// browser: TYPE-ONLY form — POST /api/__rpc/<method>, zero backend bytes
// in the client bundle
import { createClient } from "alchemy/client";
import type Backend from "../backend";
const backend = createClient<typeof Backend>();

// SSR: VALUE form — direct in-process dispatch (compiled out of the
// client bundle by the import.meta.server guard)
const { data: visits } = await useAsyncData("visits", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("../backend");
    return createClient(Backend).visit();
  }
  return backend.visit();
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR, bindings via platform proxy)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the Worker's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, `event.context.cloudflare` is served wrangler-free through cloudflare-runtime's platform proxy: resource bindings (KV, R2, D1, ...) resolve against a local workerd instance, and literal `env` values overlay them.
- Nitro's `isr` route rule is Vercel/Netlify-only and silently ignored on Cloudflare — use `prerender` (as `/about` does here) or `cache` route rules instead.
- `test/integ.test.ts` deploys the stack and asserts SSR, the API route, the prerendered page, and static assets over HTTP. It is written but not yet exercised in CI — a live run against the testing account is deferred (test-account embargo at the time this example landed).
