# AWS Website: Astro

Deploys an [Astro](https://astro.build) site to AWS with
`AWS.Website.Astro` — no `astro.config.*` adapter setup and no
CloudFormation templates. The server bundle runs on a streaming Lambda
Function URL; static assets deploy to S3 behind a CloudFront
distribution.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**:
`src/backend.ts` passes an Effect program as the third argument, and the
program's RPC methods ARE the API surface — no routes, no URL parsing
(the table name lands as an env var and its IAM policy on the Lambda
role, collected at plan time):

```ts
export default class Site extends Astro<Site>()(
  "Astro",
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

Methods are called through `createClient` (`alchemy/client`), which has
two forms:

```ts
// SSR (src/pages/index.astro frontmatter): VALUE import — direct
// in-process dispatch, no HTTP
import Backend from "../backend.ts";
const backend = createClient(Backend);
const visits = await backend.visits();

// Browser (inline <script> in index.astro): TYPE-ONLY import — zero
// backend bytes in the client bundle; each call POSTs the wire protocol
// (/api/__rpc/bump)
import { createClient } from "alchemy/client";
import type Backend from "../backend.ts";
const backend = createClient<typeof Backend>();
const count = await backend.bump();
```

The page renders "Server-rendered visits: N" during SSR and a
"Bump visits" button re-calls the backend from the browser over the wire.

### The async leg

The same class also owns an SQS-backed async flow: `enqueue(message)`
sends to the `Jobs` queue, and a `consumeQueueMessages` listener **on the
same class** consumes it — each message bumps a `processed-count` item and
records `processed-last` in the same DynamoDB table, which the
`processed()` method reads back. Because the framework-built Lambda entry
only serves HTTP, the consumer deploys automatically as a **sibling
effect Lambda** (`Astro-Handlers`) from the same `src/backend.ts` module:
the event-source mapping and its `sqs:ReceiveMessage` IAM target the
sibling, while the site Lambda stays fetch-only. In the UI, "Send to
queue" calls `enqueue` and then polls `processed()` until the count moves
— making the queue → consumer → state catch-up visible.

## Mechanics

- Zero-setup mount: on Astro the rpc wire path is served without any
  project file — the deploy target wires the backend into the server
  bundle (and `astro dev`) automatically.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served from S3 — prerendered
  pages must not call the backend server-side.
- Everything under `public/` deploys as static assets.
- The integration package must be installed in the project (it is loaded
  dynamically at deploy time): `bun add -d @alchemy.run/frontend-frameworks`

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the Astro build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

Astro's own dev server serves the frontend; both `createClient` forms run
the same backend methods against the real DynamoDB table (pinned
`remote()` in `src/backend.ts`) using your ambient AWS credentials.

The async leg runs in the local Lambda emulator in dev: the `Jobs` queue,
its event-source mapping, and the consumer all deploy there together (a
real queue cannot feed an emulated consumer, so the queue is deliberately
not `remote()`). The dev server's `enqueue` produce path is not wired to
the emulator yet — deploy to exercise the full async leg end-to-end.

## Destroy

```sh
bun run destroy
```
