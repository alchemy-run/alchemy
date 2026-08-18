# AWS Website: Nuxt

Deploys a Nuxt app to AWS with `AWS.Website.Nuxt` — no `nitro.preset` edits, no CDK.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `aws-lambda` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**: `server/backend.ts` passes an Effect program as the third argument, and the program's methods are the typed backend surface — no URL parsing, no serialization (the table name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

```ts
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    return {
      visits: () => Effect.gen(function* () { /* read the counter */ }),
      bump: () => Effect.gen(function* () { /* increment + persist */ }),
    };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
```

## The public API is nitro routes; the backend is trusted-only

Schema-less RPC never crosses a trust boundary: `createClient`
(`alchemy/Client`) is the server-side VALUE form — direct in-process
dispatch, no HTTP wire. Nuxt has a first-class server-function story
(nitro server routes), so those routes are the public API and the backend
methods are called only inside them:

```ts
// server/api/visits.post.ts — the public API surface
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export default defineEventHandler(async (event) => {
  const backend = createClient(Backend, { headers: event.headers });
  return { count: await backend.bump() }; // direct dispatch — no HTTP
});
```

The browser only ever talks to the nitro routes (`app/pages/index.vue`,
with shadcn-style components in `app/components/ui/`):

```ts
const { data: visits } = await useFetch<{ count: number }>("/api/visits");
// SSR: nitro runs the handler in-process inside the Lambda; the value
// hydrates into the client without a second request.

await $fetch("/api/visits", { method: "POST" }); // the bump button
```

The home page renders "Server-rendered visits: N" during SSR and a "Bump visits" button bumps it (optimistically) from the browser.

### The async leg

The same class also owns an SQS-backed async flow: `enqueue(message)` sends to the `Jobs` queue, and a `consumeQueueMessages` listener **on the same class** consumes it — each message bumps a `processed-count` item and records `processed-last` in the same DynamoDB table, which the `processed()` method reads back. The consumer dispatches on the site's **own server Lambda** (single-handler delivery): the generated Lambda entry serves nitro's HTTP verbatim and routes SQS batches through the program's registered listener, so the event-source mapping and its `sqs:ReceiveMessage` IAM target the server function itself — no sibling function deploys. In the UI, "Send to queue" posts to `/api/jobs` and then polls `GET /api/jobs` until the count moves — making the queue → consumer → state catch-up visible.

### The mount

HTTP composition is user code: `server/middleware/alchemy.ts` mounts the effect program (`const site = mount(Site, { routes })` from `alchemy/Serve`) and calls `site.fetch(toWebRequest(event))` — `undefined` means "not mine" and nitro continues to its own routes and pages. The middleware also answers `/healthz` itself and gates `/api/admin/*`, showing that dispatch order and gates are ordinary middleware code. The same file runs unchanged in `nuxt dev`.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is Nuxt's own dev server (native HMR). The site itself creates no AWS resources in dev, but the DynamoDB table bound by the effect program is pinned `remote()` in `server/backend.ts`, so the nitro routes dispatching the backend hit the real table with your ambient credentials.
- The async leg runs in the local Lambda emulator in dev: the `Jobs` queue, its event-source mapping, and the consumer all deploy there together (a real queue cannot feed an emulated consumer, so the queue is deliberately not `remote()`). The dev server's `enqueue` produce path is not wired to the emulator yet — deploy to exercise the full async leg end-to-end.
- `/about` is prerendered at build time — prerendered pages must not call the backend server-side (nitro's `isr` route rule is Vercel/Netlify-only and ignored on AWS Lambda; use `prerender` or `cache` route rules instead).
- `test/integ.test.ts` deploys the stack and asserts SSR (including the backend-rendered counter), the nitro API routes, the queue round-trip (nitro route AND effect-fetch produce paths), the mount's own routes (healthz, admin gate), the streaming and finalizer routes, the prerendered page, and static assets over HTTP.
