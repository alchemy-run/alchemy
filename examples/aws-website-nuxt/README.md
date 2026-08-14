# AWS Website: Nuxt

Deploys a Nuxt app to AWS with `AWS.Website.Nuxt` — no `nitro.preset` edits, no CDK.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `aws-lambda` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**: `server/backend.ts` passes an Effect program as the third argument, and the program's RPC methods ARE the API surface — no routes, no URL parsing (the table name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

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

Methods are called through `createClient` (`alchemy/Client`), which has two forms:

```ts
// SSR (app/pages/index.vue, useAsyncData handler guarded by
// import.meta.server): VALUE import — direct in-process dispatch, no HTTP
const { default: Backend } = await import("../../server/backend");
const visits = await createClient(Backend).visits();

// Browser (app/pages/index.vue): TYPE-ONLY import — zero backend bytes in
// the client bundle; each call POSTs the wire protocol (/api/__rpc/bump)
import { createClient } from "alchemy/Client";
import type Backend from "../../server/backend";
const backend = createClient<typeof Backend>();
const count = await backend.bump();
```

The home page renders "Server-rendered visits: N" during SSR and a "Bump visits" button re-calls the backend from the browser over the wire.

### The async leg

The same class also owns an SQS-backed async flow: `enqueue(message)` sends to the `Jobs` queue, and a `consumeQueueMessages` listener **on the same class** consumes it — each message bumps a `processed-count` item and records `processed-last` in the same DynamoDB table, which the `processed()` method reads back. Because the nitro-built Lambda entry only serves HTTP, the consumer deploys automatically as a **sibling effect Lambda** (`NuxtSite-Handlers`) from the same `server/backend.ts` module: the event-source mapping and its `sqs:ReceiveMessage` IAM target the sibling, while the site Lambda stays fetch-only. In the UI, "Send to queue" calls `enqueue` and then polls `processed()` until the count moves — making the queue → consumer → state catch-up visible.

## Mechanics

Zero setup: alchemy generates the mounting middleware itself (`.alchemy/nuxt/NuxtSite/effect-handler.mjs`) and injects it through nitro's `handlers` config. Nitro compiles it into the server bundle exactly like a scanned `server/middleware/*` file, so it runs in the deployed Lambda and under `nuxt dev` alike — one mechanism, both modes.

The middleware dispatches the universal rpc path (`/api/__rpc/*`) and declines everything else (the backend exposes no `fetch` and claims no routes here), so nitro's own routes keep serving normally — `/api/hello` stays a plain nitro route.

**Escape hatch:** auto-injection stands down whenever a file in `server/` already mounts `alchemy/Serve` explicitly (or with `server: { takeover: false }`), so a hand-written mount keeps working unchanged:

```ts
// server/middleware/alchemy.ts
import { toEventHandler } from "alchemy/Nitro";
import Site from "../backend.ts";

export default toEventHandler(Site);
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is Nuxt's own dev server (native HMR). The site itself creates no AWS resources in dev, but the DynamoDB table bound by the effect program is pinned `remote()` in `server/backend.ts`, so both `createClient` forms hit the real table with your ambient credentials.
- The async leg runs in the local Lambda emulator in dev: the `Jobs` queue, its event-source mapping, and the consumer all deploy there together (a real queue cannot feed an emulated consumer, so the queue is deliberately not `remote()`). The dev server's `enqueue` produce path is not wired to the emulator yet — deploy to exercise the full async leg end-to-end.
- `/about` is prerendered at build time — prerendered pages must not call the backend server-side (nitro's `isr` route rule is Vercel/Netlify-only and ignored on AWS Lambda; use `prerender` or `cache` route rules instead).
- `test/integ.test.ts` deploys the stack and asserts SSR (including the backend-rendered counter), the rpc wire path, the nitro route, the prerendered page, and static assets over HTTP.
