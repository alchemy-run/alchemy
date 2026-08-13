# AWS Website: Nuxt

Deploys a Nuxt app to AWS with `AWS.Website.Nuxt` — no `nitro.preset` edits, no CDK.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `aws-lambda` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront.

The site is **effectful**: `server/backend.ts` passes an Effect program as the third argument, and the program's RPC methods ARE the API surface — no routes, no URL parsing (the S3 bucket's name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

```ts
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    return {
      get: () => Effect.gen(function* () { /* read from S3 */ }),
      save: (value: string) => Effect.gen(function* () { /* write to S3 */ }),
    };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
```

On Nuxt the wire path mounts explicitly through one file — a nitro server middleware compiled by nitro itself, running in the deployed Lambda and under `nuxt dev` alike:

```ts
// server/middleware/alchemy.ts
import { toEventHandler } from "alchemy/serve/nitro";
import Site from "../backend.ts";

export default toEventHandler(Site);
```

Methods are called through `createClient` (`alchemy/client`), which has two forms:

```ts
// SSR (useAsyncData handler, guarded by import.meta.server): VALUE import —
// direct in-process dispatch, no HTTP
const { default: Backend } = await import("../backend");
const message = await createClient(Backend).get();

// Browser: TYPE-ONLY import — zero backend bytes in the client bundle;
// each call POSTs the wire protocol (/api/__rpc/save)
import { createClient } from "alchemy/client";
import type Backend from "../backend";
const backend = createClient<typeof Backend>();
await backend.save(draft);
```

The middleware dispatches the universal rpc path (`/api/__rpc/*`) and declines everything else, so nitro's own routes keep serving normally — `/api/hello` stays a plain nitro route while the home page reads the S3-backed message in-process during SSR and saves a new one from the browser over the wire.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is Nuxt's own dev server (native HMR). The site itself creates no AWS resources in dev, but the S3 bucket bound by the effect program is pinned `remote()` in `server/backend.ts`, so both `createClient` forms hit the real bucket with your ambient credentials.
- `/about` is prerendered at build time — prerendered pages must not call the backend server-side (nitro's `isr` route rule is Vercel/Netlify-only and ignored on AWS Lambda; use `prerender` or `cache` route rules instead).
- `test/integ.test.ts` deploys the stack and asserts SSR (including the backend-rendered value), the rpc wire path, the nitro route, the prerendered page, and static assets over HTTP.
