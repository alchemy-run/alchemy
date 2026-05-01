# cloudflare-nextjs

Minimal Next.js app deployed to a Cloudflare Worker via [OpenNext]. The
worker is uploaded by alchemy with
[`Cloudflare.Worker({ bundle: false })`][bundle-false], which is the
supported way to ship pre-built worker bundles produced by external
tools (OpenNext, wrangler, custom build pipelines, …) without alchemy
re-bundling them through rolldown.

This example is the condensed version of the original
[bug reproduction][repro] that motivated the `bundle` prop.

[OpenNext]: https://opennext.js.org/cloudflare
[bundle-false]: https://github.com/alchemy-run/alchemy-effect/pull/117
[repro]: https://github.com/czxtm/repro-alchemy-bundle-false

## What this example demonstrates

`@opennextjs/cloudflare build` emits a complete, runtime-ready ESM
worker at `.open-next/worker.js`. When alchemy runs that file through
its default rolldown step, dynamic `import()` calls inside the OpenNext
runtime are rewritten in ways that break the worker at request time:

```text
UnknownCloudflareError: Uncaught TypeError: Cannot destructure
property 'name' of '(intermediate value)' as it is undefined.
  at worker.js:1:23445 in createGenericHandler
```

`bundle: false` opts out of the rolldown step entirely. The OpenNext
output is uploaded byte-for-byte and the worker boots normally.

The relevant lines are in [`alchemy.run.ts`](./alchemy.run.ts):

```ts
yield* Cloudflare.Worker("NextjsWorker", {
  main: ".open-next/worker.js",
  bundle: false, // ← upload `main` as-is, no rolldown
  assets: { directory: ".open-next/assets", /* … */ },
  // …
});
```

## Project layout

| File                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `alchemy.run.ts`       | Single-stack alchemy program with `bundle: false`          |
| `next.config.mjs`      | Next.js config + `initOpenNextCloudflareForDev`            |
| `open-next.config.ts`  | Minimal `@opennextjs/cloudflare` config                    |
| `wrangler.jsonc`       | Required by `opennextjs-cloudflare build`'s sanity check   |
| `src/app/layout.tsx`   | Root layout                                                |
| `src/app/page.tsx`     | Server-rendered home page                                  |

The Next.js app is intentionally trivial — a single Server Component
home page. Anything richer would obscure the point: that the OpenNext
output reaches Cloudflare unmodified.

## Deploy

```bash
cp .env.example .env
$EDITOR .env # add CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID

bun install
bun run deploy
```

`bun run deploy` runs:

1. `next build` — produce a Next.js production build
2. `opennextjs-cloudflare build` — wrap it as a Cloudflare worker bundle
   under `.open-next/`
3. `alchemy deploy` — read `.open-next/worker.js`, hash it, and upload
   it to Cloudflare untouched (because `bundle: false` is set)

When the deploy finishes, alchemy prints the `workers.dev` URL. Open it
to see the home page rendered server-side inside the worker.

## Tear down

```bash
bun run destroy
```
