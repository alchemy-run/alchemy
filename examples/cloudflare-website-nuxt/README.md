# Cloudflare Website: Nuxt

Deploys a Nuxt app to Cloudflare Workers with `Cloudflare.Website.Nuxt` — no `nitro.preset` edits, no Wrangler.

## The demo

Every effectful website example is the same app: a visit counter in a KV
namespace (`Visits`, key `count`) exposed by two methods on the backend
program — `visits()` reads the count and `bump()` increments it. The page
server-renders `Server-rendered visits: {n}` and a "Bump visits" button
bumps it (optimistically) from the browser. Only the framework and cloud
mechanics vary between examples.

- `server/backend.ts` declares the Website class with an Effect program as
  its third argument: ONE Worker serves the Nuxt app and a typed backend.
  The program's METHODS (`visits`, `bump`, `enqueue`, `processed`) are the
  API surface for trusted callers, backed by the KV namespace and queue
  through typed capability bindings — collected automatically at plan time.
- `server/api/*.ts` are ordinary nitro server routes — Nuxt's own
  server-function story. They ARE the public API: each one value-imports
  the backend and dispatches a method in-process via `createClient`.
- `app/pages/index.vue` is the UI (shadcn-style components in
  `app/components/ui/`): `useFetch("/api/visits")` server-renders the
  count, and the buttons drive the same routes from the browser.

### The async leg

The same backend class also carries the demo's async leg: a Cloudflare
Queue (`Jobs`) produced to by the `enqueue(message)` method and consumed
ON THE SAME CLASS by `consumeQueueMessages` — each message bumps
`processed-count` and records `processed-last` in the `Visits` KV
namespace, and `processed()` reads that state back. The entry takeover
wraps the nitro artifact so the queue handler is delivered alongside
`fetch` — no separate consumer worker. (Queue delivery is prod-only for
Nuxt: `alchemy dev` serves the frontend, but consumed batches only flow
in a real deploy.) The UI's queue section sends a message
("Send to queue") and then polls `GET /api/jobs` (bounded, once per
second) until the count grows, so the asynchronous catch-up — queue →
consumer → KV → UI — is visible in the
`Queue-processed: {count} — last: {last}` line.

## The public API is nitro routes; the backend is trusted-only

Schema-less RPC never crosses a trust boundary: `createClient(Backend)`
is the server-side VALUE form — direct in-process dispatch, no HTTP wire.
Nuxt has a first-class server-function story (nitro server routes), so
those routes are the public API and the backend methods are called only
inside them:

```ts
// server/api/visits.post.ts — the public API surface
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export default defineEventHandler(async (event) => {
  const backend = createClient(Backend, { headers: event.headers });
  return { count: await backend.bump() }; // direct dispatch — no HTTP
});
```

The browser only ever talks to the nitro routes:

```ts
// app/pages/index.vue
const { data: visits } = await useFetch<{ count: number }>("/api/visits");
// SSR: nitro runs the handler in-process inside the Worker; the value
// hydrates into the client without a second request.

await $fetch("/api/visits", { method: "POST" }); // the bump button
```

Because the route handlers live in the nitro server graph (the same graph
as the generated Worker entry), the value form dispatches in-process on
workerd — the backend is never bundled into the vue client (or server)
build.

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
- `test/integ.test.ts` deploys the stack and asserts SSR (including the backend-rendered counter), the nitro API routes, the queue round-trip, the prerendered page, and static assets over HTTP.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR, bindings via platform proxy)
bun alchemy destroy  # tear down
```
