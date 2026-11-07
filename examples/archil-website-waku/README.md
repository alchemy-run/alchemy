# Archil Website: Waku

Deploys a [Waku](https://waku.gg) site to Archil with
`Archil.Website.Waku` — no adapter setup in the project config.

The Node adapter bundle runs as an Archil service in an Archil sandbox, at its public `https://3000-…archil.app` URL.


- The home page is server-rendered on the Archil sandbox and reads `GREETING` from `process.env`.
- A Tailwind-styled Card component ships with the page.
- Static assets under `public/` (or `static/`) deploy with the service.

```ts
const site = yield* Archil.Website.Waku("WakuSite", {
  env: { GREETING: "Hello from Waku on Archil!" },
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

`alchemy dev` runs the framework's own dev server (HMR included) and
no cloud resources are created.

## Destroy

```sh
bun run destroy
```
