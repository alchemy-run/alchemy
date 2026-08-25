# Fly Vite Example

Deploys a [Vite](https://vite.dev) SPA to Fly with `Fly.Website.Vite` — no
Dockerfile, `fly.toml`, or adapter setup.

- `alchemy deploy` runs `vite build` and serves the output from a Fly
  Machine at `https://{app}.fly.dev`.
- `alchemy dev` starts Vite's own dev server (HMR included). No Fly App
  or Service is created; `site.url` is the local address.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```
