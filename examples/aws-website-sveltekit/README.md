# AWS Website: SvelteKit

Deploys a SvelteKit app to AWS with `AWS.Website.SvelteKit` — no `svelte.config.js` adapter, no CDK.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory AWS adapter, deploys the server output on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront.

The site is **effectful**: `src/backend.ts` passes an Effect program as the third argument, and the program's RPC methods ARE the API surface — no routes, no URL parsing (the S3 bucket's name lands as an env var and its IAM policy on the Lambda role, collected at plan time):

```ts
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
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

Methods are called through `createClient` (`alchemy/client`), which has two forms:

```ts
// SSR (src/routes/+page.server.ts): VALUE import — direct in-process dispatch
import Backend from "../backend.ts";
const backend = createClient(Backend);
export const load = async () => ({ message: await backend.get() });

// Browser (+page.svelte): TYPE-ONLY import — zero backend bytes in the client
// bundle; each call POSTs the wire protocol (/api/__rpc/save)
import { createClient } from "alchemy/client";
import type Backend from "../backend.ts";
const backend = createClient<typeof Backend>();
await backend.save(draft);
```

The home page renders the S3-backed message during SSR and saves a new one from the browser over the wire — both through the same typed backend methods, in the deployed Lambda and in `vite dev` alike.

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is kit's own Vite dev server (plain Node SSR) — already the AWS Lambda programming model, `process.env` included. The site itself creates no cloud resources in dev, but the S3 bucket bound by the effect program is pinned `remote()` in `src/backend.ts`, so both `createClient` forms hit the real bucket with your ambient credentials.
- `src/routes/about` is prerendered at build time — prerendered pages must not call the backend server-side.
