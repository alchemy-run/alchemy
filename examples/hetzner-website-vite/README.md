# Hetzner Website: Vite

Deploys a [Vite](https://vite.dev) SPA to Hetzner Cloud with
`Hetzner.Website.Vite` — `vite build` output served by a generated Node
static-file server as a systemd unit on an auto-created `cx22` Server in
`fsn1`.

During `alchemy dev` the site is Vite's own dev server (HMR included)
and no Server or Service is created.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
export HCLOUD_TOKEN=...
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

The site URL is `http://{ipv4}:3000` (no TLS on Service).

## Destroy

```sh
bun run destroy
```
