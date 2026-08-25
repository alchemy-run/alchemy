# Railway Website: Vite

Deploys a [Vite](https://vite.dev) SPA to Railway with
`Railway.Website.Vite` — `vite build` output served by a generated Node
static-file server on one `Railway.Service`.

During `alchemy dev` the site is Vite's own dev server (HMR included)
and no Railway Project or Service is created.

Effect-native images are pushed to `RAILWAY_REGISTRY` (GHCR / Docker
Hub). Railway has no private registry of its own.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
export RAILWAY_REGISTRY=ghcr.io/your-org
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```

## Optional Custom Domain

Set `RAILWAY_TEST_DOMAIN` to a hostname you control before deploy to
attach it via `Railway.CustomDomain`. Without it, the example returns
the generated `*.up.railway.app` URL.
