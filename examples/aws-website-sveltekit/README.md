# AWS Website: SvelteKit

Deploys a SvelteKit app to AWS with `AWS.Website.SvelteKit` — no `svelte.config.js` adapter, no CDK.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory AWS adapter, deploys the server output on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront. Values passed via `server.environment` are exposed to server routes through `process.env`.

The site is **effectful**: `src/site.ts` passes an Effect program as the third argument, so the same Lambda that renders the kit app also serves an effect-native API under `/api/*` with typed AWS capabilities (the S3 bucket's name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

```ts
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    return { fetch: Effect.gen(function* () { /* /api/message */ }) };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
```

Delivery is automatic for SvelteKit: the effect `fetch` serves `server.routes` (default `["/api/*"]`) — in the deployed Lambda and in `vite dev` alike. Inside the routes the program is authoritative (even its 404s); outside them kit's own handlers serve. To hand a path back to kit, exclude it: `routes: ["/api/*", "!/api/foo"]`. The home page reads and writes the S3-backed `/api/message` route.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is kit's own Vite dev server (plain Node SSR) — already the AWS Lambda programming model, `process.env` included. The site itself creates no cloud resources in dev, but the S3 bucket bound by the effect program is pinned `remote()` in `src/site.ts`, so `/api/message` hits the real bucket with your ambient credentials.
