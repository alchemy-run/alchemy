# AWS Website: SvelteKit

Deploys a SvelteKit app to AWS with `AWS.Website.SvelteKit` — no `svelte.config.js` adapter, no CDK.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory AWS adapter, deploys the server output on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**: `src/backend.ts` passes an Effect program as the third argument, and the program's RPC methods ARE the API surface — no routes, no URL parsing (the table name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

```ts
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
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

Methods are called through `createClient` (`alchemy/client`), which has two forms:

```ts
// SSR (src/routes/+page.server.ts): VALUE import — direct in-process dispatch
import Backend from "../backend.ts";
const backend = createClient(Backend);
export const load = async () => ({ visits: await backend.visits() });

// Browser (src/routes/+page.svelte): TYPE-ONLY import — zero backend bytes in
// the client bundle; each call POSTs the wire protocol (/api/__rpc/bump)
import { createClient } from "alchemy/client";
import type Backend from "../backend.ts";
const backend = createClient<typeof Backend>();
const count = await backend.bump();
```

The home page renders "Server-rendered visits: N" during SSR and a "Bump visits" button re-calls the backend from the browser over the wire — both through the same typed backend methods, in the deployed Lambda and in `vite dev` alike.

### The async leg

The same class also owns an SQS-backed async flow: `enqueue(message)` sends to the `Jobs` queue, and a `consumeQueueMessages` listener **on the same class** consumes it — each message bumps a `processed-count` item and records `processed-last` in the same DynamoDB table, which the `processed()` method reads back. Because the framework-built Lambda entry only serves HTTP, the consumer deploys automatically as a **sibling effect Lambda** (`SvelteKitSite-Handlers`) from the same `src/backend.ts` module: the event-source mapping and its `sqs:ReceiveMessage` IAM target the sibling, while the site Lambda stays fetch-only. In the UI, "Send to queue" calls `enqueue` and then polls `processed()` until the count moves — making the queue → consumer → state catch-up visible.

## Mechanics

- Zero-setup mount: on SvelteKit the rpc wire path is served without any project file — the deploy target wires the backend into the server bundle (and `vite dev`) automatically.
- `src/routes/about` is prerendered at build time — prerendered pages must not call the backend server-side.
- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

In `alchemy dev`, the site is kit's own Vite dev server (plain Node SSR) — already the AWS Lambda programming model, `process.env` included. The site itself creates no cloud resources in dev, but the DynamoDB table bound by the effect program is pinned `remote()` in `src/backend.ts`, so both `createClient` forms hit the real table with your ambient credentials.

The async leg runs in the local Lambda emulator in dev: the `Jobs` queue, its event-source mapping, and the consumer all deploy there together (a real queue cannot feed an emulated consumer, so the queue is deliberately not `remote()`). The dev server's `enqueue` produce path is not wired to the emulator yet — deploy to exercise the full async leg end-to-end.
