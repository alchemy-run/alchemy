# AWS Website: Astro

Deploys an [Astro](https://astro.build) site to AWS with
`AWS.Website.Astro` — no `astro.config.*` adapter setup and no
CloudFormation templates. The server bundle runs on a streaming Lambda
Function URL; static assets deploy to S3 behind a CloudFront
distribution.

The site is **effectful**: `src/backend.ts` passes an Effect program as the
third argument, so the same Lambda that renders Astro pages also serves
an effect-native API under `/api/*` with typed AWS capabilities:

```ts
export default class Site extends Astro<Site>()(
  "Astro",
  { main: import.meta.url },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table); // env var + IAM at plan
    const putItem = yield* DynamoDB.PutItem(table);
    return { fetch: Effect.gen(function* () { /* /api/visits */ }) };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
```

- `src/pages/index.astro` is server-rendered in the Lambda on every
  request and calls `/api/visits` — the DynamoDB-backed visit counter
  declared in `src/backend.ts`.
- Delivery is automatic for Astro: the effect `fetch` serves
  `server.routes` (default `["/api/*"]`) in the production Lambda and in
  `astro dev` alike. Inside the routes the program is authoritative
  (even its 404s); outside them Astro's own pipeline serves. To hand a
  path back to Astro, exclude it: `routes: ["/api/*", "!/api/foo"]`.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served from S3.
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

Astro's own dev server serves the frontend; `/api/*` runs the same
Effect program against the real DynamoDB table (pinned `remote()` in
`src/backend.ts`) using your ambient AWS credentials.

## Destroy

```sh
bun run destroy
```
