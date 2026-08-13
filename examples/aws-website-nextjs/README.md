# AWS Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to AWS with
`AWS.Website.Nextjs` — the OpenNext (`@opennextjs/aws`) serverless
topology with zero CDK or CloudFormation wiring: the SSR server runs on
a streaming Lambda Function URL, static assets (including prerendered
pages) deploy to S3 behind CloudFront, images are optimized by a
dedicated Lambda at `/_next/image`, and ISR revalidation flows through
an SQS FIFO queue plus a DynamoDB tag-cache table.

The site is **effectful**: `src/backend.ts` passes an Effect program as the
third argument, so the same Lambda that renders the app also serves an
effect-native API with typed AWS capabilities (the S3 bucket's name
lands as an env var and its IAM policy on the Lambda role, collected at
plan time). On Next.js the program mounts explicitly through one file —
a catch-all route handler compiled by Next itself:

```ts
// app/api/[[...slug]]/route.ts
import { toRouteHandler } from "alchemy/serve/next";
import Site from "../../../src/backend.ts";

const handler = toRouteHandler(Site);
export { handler as GET, handler as POST /* ... */ };
```

- `app/page.jsx` is server-rendered in the Lambda on every request and
  reads the `GREETING` environment value declared in `src/backend.ts` via
  `process.env`; its `EffectMessage` island round-trips `/api/message`
  through the Effect program's S3 binding.
- `app/api/hello/route.ts` is an ordinary app-router route handler —
  more-specific routes keep winning over the catch-all, so Next's own
  routing and the effect API coexist under `/api/*`.
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
itself creates no cloud resources in dev, but the S3 bucket bound by the
effect program is pinned `remote()` in `src/backend.ts`, so `/api/message`
hits the real bucket with your ambient credentials.

## Destroy

```sh
bun run destroy
```
