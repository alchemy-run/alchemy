# AWS Website: Astro

Deploys an [Astro](https://astro.build) site to AWS with
`AWS.Website.Astro` — no `astro.config.*` adapter setup and no
CloudFormation templates. The server bundle runs on a streaming Lambda
Function URL; static assets deploy to S3 behind a CloudFront
distribution.

The site is **effectful**: `src/backend.ts` passes an Effect program as the
third argument, and the program's RPC methods ARE the API surface — no
routes, no URL parsing:

```ts
export default class Site extends Astro<Site>()(
  "Astro",
  { main: import.meta.url },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table); // env var + IAM at plan
    const putItem = yield* DynamoDB.PutItem(table);
    return {
      visit: () => Effect.gen(function* () { /* DynamoDB counter */ }),
    };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
```

Methods are called through `createClient` (`alchemy/client`), which has
two forms:

```ts
// SSR (Astro frontmatter): VALUE import — direct in-process dispatch, no HTTP
import Backend from "../backend.ts";
const backend = createClient(Backend);
const count = await backend.visit();

// Browser (client <script>): TYPE-ONLY import — zero backend bytes in the
// client bundle; each call POSTs the wire protocol (/api/__rpc/visit)
import { createClient } from "alchemy/client";
import type Backend from "../backend.ts";
const backend = createClient<typeof Backend>();
const count = await backend.visit();
```

- `src/pages/index.astro` is server-rendered in the Lambda on every
  request: the frontmatter calls `backend.visit()` in-process and renders
  the count; a button re-calls the same method from the browser over the
  wire.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served from S3 — prerendered
  pages must not call the backend server-side.
- Everything under `public/` deploys as static assets.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

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

## Destroy

```sh
bun run destroy
```
