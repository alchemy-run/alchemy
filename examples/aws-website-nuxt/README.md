# AWS Website: Nuxt

Deploys a Nuxt app to AWS with `AWS.Website.Nuxt` — no `nitro.preset` edits, no CDK.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `aws-lambda` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront. Values passed via `server.environment` are exposed to server routes and SSR through `process.env`.

The site is **effectful**: `src/site.ts` passes an Effect program as the third argument, so the same Lambda that serves the Nuxt app also serves an effect-native API with typed AWS capabilities (the S3 bucket's name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

```ts
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    return { fetch: Effect.gen(function* () { /* /api/message */ }) };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
```

On Nuxt the program mounts explicitly through one file — a nitro server middleware compiled by nitro itself, running in the deployed Lambda and under `nuxt dev` alike:

```ts
// server/middleware/alchemy.ts
import { toEventHandler } from "alchemy/serve/nitro";
import Site from "../../src/site.ts";

export default toEventHandler(Site);
```

The middleware offers every request to the Effect program; a `passthrough` lets nitro's own handlers keep answering — `/api/hello` stays a plain nitro route while `/api/message` round-trips through the program's S3 binding (the home page demos both).

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is Nuxt's own dev server (native HMR). The site itself creates no AWS resources in dev, but the S3 bucket bound by the effect program is pinned `remote()` in `src/site.ts`, so `/api/message` hits the real bucket with your ambient credentials.
- Nitro's `isr` route rule is Vercel/Netlify-only and ignored on AWS Lambda — use `prerender` (as `/about` does here) or `cache` route rules instead.
- `test/integ.test.ts` deploys the stack and asserts SSR, the API route, the prerendered page, and static assets over HTTP.
