# AWS Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to AWS with
`AWS.Website.Nextjs` — the OpenNext (`@opennextjs/aws`) serverless
topology with zero CDK or CloudFormation wiring: the SSR server runs on
a streaming Lambda Function URL, static assets (including prerendered
pages) deploy to S3 behind CloudFront, images are optimized by a
dedicated Lambda at `/_next/image`, and ISR revalidation flows through
an SQS FIFO queue plus a DynamoDB tag-cache table.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**:
`app/backend.ts` passes an Effect program as the third argument, and the
program's RPC methods ARE the API surface — no routes, no URL parsing
(the table name lands as an env var and its IAM policy on the Lambda
role, collected at plan time):

```ts
export default class Site extends Nextjs<Site>()(
  "Nextjs",
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

```tsx
// SSR (app/page.tsx, async server component): VALUE import — direct
// in-process dispatch, no HTTP
import Backend from "./backend.ts";
const backend = createClient(Backend);
const visits = await backend.visits();

// Browser (app/visits.tsx, "use client"): TYPE-ONLY import — zero
// backend bytes in the client bundle; each call POSTs the wire protocol
// (/api/__rpc/bump) through the catch-all route handler
import { createClient } from "alchemy/client";
import type Backend from "./backend.ts";
const backend = createClient<typeof Backend>();
const count = await backend.bump();
```

The home page renders "Server-rendered visits: N" during SSR
(`dynamic = "force-dynamic"` — a prerendered page must not call the
backend server-side) and the `"use client"` child's "Bump visits" button
re-calls the backend from the browser over the wire.

## Mechanics

On Next.js the wire path mounts explicitly through one file — a
catch-all route handler compiled by Next itself:

```ts
// app/api/[[...slug]]/route.ts
import { toRouteHandler } from "alchemy/serve/next";
import Site from "../../backend.ts";

const handler = toRouteHandler(Site);
export { handler as GET, handler as POST /* ... */ };
```

- `app/api/hello/route.ts` is an ordinary app-router route handler —
  more-specific routes keep winning over the catch-all, so Next's own
  routing and the rpc dispatch coexist under `/api/*`.
- Everything under `public/` deploys as static assets.

The integration packages must be installed in the project (the source
provider is loaded dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks @opennextjs/aws
```

`open-next.config.ts` is the minimal default the AWS deploy target
generates when a project has none: the server uses the
`aws-lambda-streaming` wrapper so the emitted handler streams on the
Function URL (`invokeMode: RESPONSE_STREAM`).

> [!NOTE]
> Running this example from inside the alchemy monorepo hits a known
> OpenNext limitation: the repo's bun *isolated* installs store packages
> behind `node_modules/.bun` symlinks, and OpenNext's file trace ships
> the server's `node_modules` as symlinks that the Lambda zip flattens —
> breaking store-sibling resolution (`Cannot find module
> '@swc/helpers/...'` at runtime). A standalone copy of this project
> (plain `bun install`, hoisted `node_modules`) deploys and serves
> correctly.

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the OpenNext build entirely on subsequent
deploys — the input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

Local dev is Next's own dev server (`next dev`, native HMR). The site
itself creates no cloud resources in dev, but the DynamoDB table bound by
the effect program is pinned `remote()` in `app/backend.ts`, so both
`createClient` forms hit the real table with your ambient credentials.

## Destroy

```sh
bun run destroy
```
