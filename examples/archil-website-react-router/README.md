# Archil Website: React Router

Deploys a [React Router](https://reactrouter.com) v7 (framework mode)
site to Archil with `Archil.Website.ReactRouter` — no adapter setup in
the project config.

The Node adapter bundle runs as an Archil service in an Archil sandbox, at its public `https://3000-…archil.app` URL.


- `app/routes/home.tsx` is server-rendered on the Archil sandbox and reads `GREETING` from `process.env`.
- `app/components/Card.tsx` is a React component styled with Tailwind utilities.
- Static assets under `public/` deploy with the service.

```ts
const site = yield* Archil.Website.ReactRouter("Website", {
  env: { GREETING: "Hello from React Router on Archil!" },
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
