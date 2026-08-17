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

Methods are called through `createClient` (`alchemy/Client`) — the
server-only VALUE form, dispatched in-process. The browser reaches the
backend through Next's own transport: the server actions in
`app/actions.ts` are the public API, and inside them the same value form
runs (trusted server code):

```tsx
// SSR (app/page.tsx, async server component): VALUE import — direct
// in-process dispatch, no HTTP
import Backend from "./backend";
const backend = createClient(Backend);
const visits = await backend.visits();
```

```ts
// app/actions.ts ("use server"): the actions ARE the public API
const backend = createClient(Backend, { headers });
export async function bumpVisits(): Promise<number> {
  return backend.bump();
}
```

```tsx
// app/visits-card.tsx ("use client"): imports ONLY ./actions — zero
// backend bytes in the client bundle
import { bumpVisits } from "./actions";
setBumped(await bumpVisits());
```

The home page renders "Server-rendered visits: N" during SSR
(`dynamic = "force-dynamic"` — a prerendered page must not call the
backend server-side) and the `"use client"` card's "Bump visits" button
re-calls the backend from the browser through the `bumpVisits` server
action. The UI is Tailwind with hand-copied shadcn-style components
(`app/components/ui/`).

### The async leg

The same class also owns an SQS-backed async flow: `enqueue(message)`
sends to the `Jobs` queue, and a `consumeQueueMessages` listener **on the
same class** consumes it — each message bumps a `processed-count` item and
records `processed-last` in the same DynamoDB table, which the
`processed()` method reads back. Because the OpenNext-built Lambda entry
only serves HTTP, the consumer deploys automatically as a **sibling
effect Lambda** (`Nextjs-Handlers`) from the same `app/backend.ts` module:
the event-source mapping and its `sqs:ReceiveMessage` IAM target the
sibling, while the site Lambda stays fetch-only. In the UI, "Send to
queue" (`app/queue-card.tsx`) calls the `enqueueJob` server action and
then polls `getProcessed` until the count moves — making the queue →
consumer → state catch-up visible.

## Mechanics

Zero-setup: alchemy composes into the OpenNext build automatically — a
custom OpenNext `wrapper` override (generated under
`.alchemy/generated/`, never in your project) resolves the effect
runtime at the fetch layer and delegates the Lambda streaming wrap to
OpenNext's stock wrapper, so the server actions' value-form dispatch
runs inside the same server Lambda. Under `alchemy dev`, an
alchemy-owned dev server embeds Next (`next({ dev: true })`), so dev and
deploy route identically. No mount file, no `open-next.config.ts` in
your project (a derived one is generated; if you have your own it is
imported and extended).

- `app/api/hello/route.ts` is an ordinary app-router route handler —
  Next's own routing is untouched under `/api/*`.
- Everything under `public/` deploys as static assets.
- To expose a public HTTP API of your own (for untrusted clients),
  define an effect `HttpApi` schema and mount it — e.g. via
  `toHandler` from `alchemy/Next` in a catch-all route.

The integration packages must be installed in the project (the source
provider is loaded dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks @opennextjs/aws
```

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
the effect program is pinned `remote()` in `app/backend.ts`, so the
value-form dispatch (server components and server actions alike) hits
the real table with your ambient credentials.

The async leg runs in the local Lambda emulator in dev: the `Jobs` queue,
its event-source mapping, and the consumer all deploy there together (a
real queue cannot feed an emulated consumer, so the queue is deliberately
not `remote()`). The dev server's `enqueue` produce path is not wired to
the emulator yet — deploy to exercise the full async leg end-to-end.

## Destroy

```sh
bun run destroy
```
