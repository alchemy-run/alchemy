# AWS Website: SvelteKit

Deploys a SvelteKit app to AWS with `AWS.Website.SvelteKit` — no `svelte.config.js` adapter, no CDK.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory AWS adapter, deploys the server output on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**: `src/backend.ts` passes an Effect program as the third argument, and the program's methods are the API surface for trusted server code — no routes, no URL parsing (the table name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

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

Schema-less RPC is for trusted callers only — there is no public wire. SvelteKit's server files import the backend **as a value** and dispatch in-process with `createClient` (`alchemy/Client`); the load function and form actions ARE the public API:

```ts
// src/routes/+page.server.ts — load + form actions are what the browser talks to
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export const load = async ({ request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return { visits: await backend.visits() };
};

export const actions = {
  bump: async ({ request }) => {
    const backend = createClient(Backend, { headers: request.headers });
    return { bumped: await backend.bump() };
  },
};
```

The home page renders "Server-rendered visits: N" during SSR, and the "Bump visits" button submits the `bump` form action (progressively enhanced with `use:enhance`, optimistic count included) — the browser never imports the backend, in the deployed Lambda and in `vite dev` alike. The UI is built from hand-copied shadcn-style Svelte components in `src/lib/components/ui/`.

### The async leg

The same class also owns an SQS-backed async flow: the `enqueue` form action sends to the `Jobs` queue, and a `consumeQueueMessages` listener **on the same class** consumes it — each message bumps a `processed-count` item and records `processed-last` in the same DynamoDB table, which the `processed()` method reads back. Because the framework-built Lambda entry only serves HTTP, the consumer deploys automatically as a **sibling effect Lambda** (`SvelteKitSite-Handlers`) from the same `src/backend.ts` module: the event-source mapping and its `sqs:ReceiveMessage` IAM target the sibling, while the site Lambda stays fetch-only. In the UI, "Send to queue" submits the form action and then polls the `GET /api/processed` JSON route (a plain framework API route over the same value-form client) until the count moves — making the queue → consumer → state catch-up visible.

## Mechanics

- SvelteKit's own transports are the public surface: `+page.server.ts` (load + actions) and `src/routes/api/processed/+server.ts` are the only places the backend is imported — and they never ship to the browser.
- `src/routes/about` is prerendered at build time — prerendered pages must not call the backend server-side.
- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

In `alchemy dev`, the site is kit's own Vite dev server (plain Node SSR) — already the AWS Lambda programming model, `process.env` included. The site itself creates no cloud resources in dev, but the DynamoDB table bound by the effect program is pinned `remote()` in `src/backend.ts`, so the value-form client behind the form actions hits the real table with your ambient credentials.

The async leg runs in the local Lambda emulator in dev: the `Jobs` queue, its event-source mapping, and the consumer all deploy there together (a real queue cannot feed an emulated consumer, so the queue is deliberately not `remote()`). The dev server's `enqueue` produce path is not wired to the emulator yet — deploy to exercise the full async leg end-to-end.
