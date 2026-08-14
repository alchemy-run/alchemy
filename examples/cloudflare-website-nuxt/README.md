# Cloudflare Website: Nuxt

Deploys a Nuxt app to Cloudflare Workers with `Cloudflare.Website.Nuxt` — no `nitro.preset` edits, no Wrangler.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two RPC methods on the
backend program — `visits()` reads the count and `bump()` increments it.
The page server-renders `Server-rendered visits: {n}` and a "Bump visits"
button calls `bump()` from the browser. Only the framework and cloud
mechanics vary between examples.

- `server/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the Nuxt app and a typed backend
  API. The program's RPC METHODS (`visits`, `bump`) are the API surface,
  backed by the KV namespace through a typed capability binding —
  collected automatically at plan time.
- `app/pages/index.vue` is the UI: the `useAsyncData` server branch
  server-renders the count and the button bumps it from the browser.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` RPC method and
consumed ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The entry takeover
wraps the nitro artifact so the queue handler is delivered alongside
`fetch` — no separate consumer worker. (Queue delivery is prod-only for
Nuxt: `alchemy dev` serves the frontend, but consumed batches only flow
in a real deploy.) The UI's queue section sends a message
("Send to queue") and then polls `processed()` (bounded, once per second)
until the count grows, so the asynchronous catch-up — queue → consumer →
KV → UI — is visible in the `Queue-processed: {count} — last: {last}`
line.

## createClient — both forms

```ts
// app/pages/index.vue (browser): TYPE-ONLY form — POST
// /api/__rpc/<method>, zero backend bytes in the client bundle
import { createClient } from "alchemy/client";
import type Backend from "~~/server/backend";
const backend = createClient<typeof Backend>();
// await backend.bump()
```

```ts
// app/pages/index.vue (SSR): VALUE form — direct in-process dispatch
// (compiled out of the client bundle by the import.meta.server guard)
const { data: visits } = await useAsyncData("visits", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("~~/server/backend");
    return createClient(Backend).visits();
  }
  return backend.visits();
});
```

> KNOWN GAP (Cloudflare deploys): the value form currently errors inside
> the deployed Worker's vue server graph (nuxt's vite-builder resolves the
> alchemy/effect graph node-flavored; it breaks on workerd), so the SSR
> branch yields `null` and the page catches up client-side through the
> type-only form (`onMounted` in `app/pages/index.vue`). The gated test in
> `test/integ.test.ts` documents the exact failure.

## Mechanics: route ownership

The program also keeps a `fetch` owning `server.routes`
(`["/api/*", "!/api/hello"]`) to demonstrate route ownership: inside the
claim the program is authoritative (even its 404s); the `!/api/hello`
exclusion statically hands that path back to nitro, so the app's own
`server/api/hello.ts` route keeps answering. (The RPC dispatch at
`/api/__rpc/*` needs no claim — it is checked before `server.routes` on
every effectful Website.)

```ts
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  {
    main: import.meta.url,
    server: { routes: ["/api/*", "!/api/hello"] },
  },
  Effect.gen(function* () {
    // ...
    return {
      fetch: HttpServerResponse.json(
        { error: "unknown effect route" },
        { status: 404 },
      ),
      // visits, bump ...
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
```

## Notes

- The resource builds the app through the project's own `@nuxt/kit` with
  nitro's `cloudflare_module` preset (your `nuxt.config.ts` loads
  natively), deploys the nitro server bundle as the Worker, and serves
  client assets + prerendered pages as Worker static assets. Values passed
  via `env` are exposed to server routes and SSR through
  `event.context.cloudflare.env`.
- `@alchemy.run/frontend-frameworks` must be installed in the project — the Worker's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, `event.context.cloudflare` is served wrangler-free through cloudflare-runtime's platform proxy: resource bindings (KV, R2, D1, ...) resolve against a local workerd instance, and literal `env` values overlay them.
- Nitro's `isr` route rule is Vercel/Netlify-only and silently ignored on Cloudflare — use `prerender` (as `/about` does here) or `cache` route rules instead.
- `test/integ.test.ts` deploys the stack and asserts SSR, the RPC surface, the exclusion demo, the prerendered page, and static assets over HTTP.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR, bindings via platform proxy)
bun alchemy destroy  # tear down
```
