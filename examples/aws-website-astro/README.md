# AWS Website: Astro

Deploys an [Astro](https://astro.build) site to AWS with
`AWS.Website.Astro` — no `astro.config.*` adapter setup and no
CloudFormation templates. The server bundle runs on a streaming Lambda
Function URL; static assets deploy to S3 behind a CloudFront
distribution.

## The demo

A DynamoDB-backed visits counter. The site is **effectful**:
`src/backend.ts` passes an Effect program as the third argument, and the
program's RPC methods ARE the API surface for trusted callers — no
routes, no URL parsing (the table name lands as an env var and its IAM
policy on the Lambda role, collected at plan time):

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

Schema-less RPC is for trusted callers only — there is no public RPC
wire. Server code calls the methods through the in-process VALUE form of
`createClient` (`alchemy/Client`), and the browser goes through Astro
Actions, the framework's own transport:

```ts
// SSR (src/pages/index.astro frontmatter): VALUE import — direct
// in-process dispatch, no HTTP
import Backend from "../backend.ts";
const backend = createClient(Backend, { headers: Astro.request.headers });
const visits = await backend.visits();
```

```ts
// src/actions/index.ts — the PUBLIC API (framework-validated, zod input)
export const server = {
  bump: defineAction({ handler: (_input, ctx) => backend(ctx).bump() }),
  enqueue: defineAction({
    input: z.object({ message: z.string().min(1).max(256) }),
    handler: ({ message }, ctx) => backend(ctx).enqueue(message),
  }),
};
```

```tsx
// src/components/VisitsCard.tsx (browser): the framework's typed client
import { actions } from "astro:actions";
const count = await actions.bump.orThrow();
```

The UI is a React island (`src/components/VisitsCard.tsx`) styled with
Tailwind and hand-copied shadcn-style components (`src/components/ui/`):
it server-renders "Server-rendered visits: N", bumps optimistically from
the browser, and polls the queue state until the consumer catches up.

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
queue" calls the `enqueue` action and then polls the `processed` action
until the count moves — making the queue → consumer → state catch-up
visible.

## Mechanics

- Astro Actions serve at `POST /_actions/<name>`; CloudFront forwards the
  asset-manifest miss to the server Lambda, where Astro's own pipeline
  validates the input and runs the handler.
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

Astro's own dev server serves the frontend; the frontmatter's value-form
calls and the Astro Action handlers run the same backend methods against
the real DynamoDB table (pinned `remote()` in `src/backend.ts`) using
your ambient AWS credentials.

The async leg runs in the local Lambda emulator in dev: the `Jobs` queue,
its event-source mapping, and the consumer all deploy there together (a
real queue cannot feed an emulated consumer, so the queue is deliberately
not `remote()`). The dev server's `enqueue` produce path is not wired to
the emulator yet — deploy to exercise the full async leg end-to-end.

## Destroy

```sh
bun run destroy
```
