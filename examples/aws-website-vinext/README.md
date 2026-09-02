# AWS Website: vinext

Deploys a [vinext](https://vinext.dev) site to AWS with
`AWS.Website.Vinext` — Next.js API on Vite, RSC on a streaming Lambda
Function URL, static assets on S3 + CloudFront. Not OpenNext and not
the Cloudflare Worker path.

- `app/page.tsx` is prerendered (no `process.env` on the page).
- `app/api/hello/route.ts` is an App Router API route.
- `app/isr/page.tsx` is ISR (`revalidate: 60`) stored in S3 via
  `vinext({ ...alchemy() })` / `CACHE_BUCKET_NAME` (provisioned by
  the resource).
- This is `vinext build` plus a Lambda fetch-handler wrap.

```ts
const site = yield* AWS.Website.Vinext("Vinext", {
  env: { GREETING: "Hello from vinext on AWS!" },
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
bun run deploy
```

## Dev

```sh
bun run dev
```

`alchemy dev` runs vinext's own dev server (HMR included) and no cloud
resources are created.

## Destroy

```sh
bun run destroy
```
