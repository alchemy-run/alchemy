# Railway Website: vinext

Deploys a [vinext](https://vinext.dev) site to Railway with
`Railway.Website.Vinext` — Next.js API on Vite, as a long-running Node
process. Not OpenNext and not the Cloudflare Worker path.

- `app/page.tsx` is server-rendered on the Railway Service and reads
  `GREETING` from `process.env`.
- `app/api/hello/route.ts` is an App Router API route.
- `app/isr/page.tsx` is ISR (`revalidate: 60`) stored in Redis via
  `redisAdapter()` / `REDIS_URL`.
- This is `vinext build` plus vinext's production server.

```ts
const project = yield* Railway.Project("Project");
const redis = yield* Railway.Redis("Cache", { project });
const site = yield* Railway.Website.Vinext("Vinext", {
  project,
  env: {
    GREETING: "Hello from vinext on Railway!",
    REDIS_URL: Railway.ref(redis, "REDIS_URL"),
  },
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

Unchanged sources skip the build entirely on subsequent deploys — the
input files are content-hashed (scoped by `memo.include`).

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
