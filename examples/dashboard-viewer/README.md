# dashboard-viewer

Deploys the alchemy dashboard as a **hosted state viewer**: the same
`@alchemy.run/dashboard` SPA the CLI serves for `alchemy deploy --ui`, but
running as a Cloudflare Worker that reads a deployed alchemy state store
over its HTTP API — no CLI process required.

The Worker serves the SPA as static assets and implements the dashboard's
read-only API (`alchemy/Dashboard/Viewer`): document snapshots, SSE with
store polling, deployment history and journals, resource state, and stack
outputs.

## Configure

Nothing is required on a machine that has deployed with
`Cloudflare.state()` before: the viewer reads the endpoint + bearer token
that alchemy caches at
`~/.alchemy/credentials/{profile}/cloudflare-state-store.json`, so a
plain `bun run deploy` targets the same store your CLI uses. To point at
a different store (or in CI), set them explicitly — env vars win over
the cached credentials:

```sh
export ALCHEMY_STATE_URL="https://alchemy-state-store.<subdomain>.workers.dev"
export ALCHEMY_STATE_TOKEN="<the store's bearer token>"
```

Optional:

```sh
export ALCHEMY_VIEWER_STACK="MyStack"   # default: first stack in the store
export ALCHEMY_VIEWER_STAGE="prod"      # default: first stage of the stack
export ALCHEMY_DASHBOARD_DIST=".../dist" # default: ../../packages/dashboard/dist
export ALCHEMY_STATE_SERVICE="alchemy-state-store" # "" to disable the service binding
```

## Same-zone transport

Cloudflare blocks same-zone worker-to-worker `fetch` (error 1042, which
surfaces as a 404), so a viewer deployed on the same account as
`alchemy-state-store` cannot reach it over plain HTTP. The example
therefore registers a **service binding** to the state-store Worker
(script name from `ALCHEMY_STATE_SERVICE`, default `alchemy-state-store`)
and routes the state client's requests through it; the URL and bearer
token stay the same in both modes. If the two workers live on different
zones (a custom domain on either side), set `ALCHEMY_STATE_SERVICE=""`
to skip the binding and use plain fetch.

## Deploy

```sh
bun run deploy
```

`predeploy` builds the SPA (`packages/dashboard/dist`); the deploy uploads
it as Worker assets with SPA fallback and routes `/api/*` to the viewer.

## Access control

The viewer exposes everything the state store token can read (resource
props/attrs with secrets redacted by the state encoding, deployment
journals, outputs). Put the deployed URL behind Cloudflare Access (or an
equivalent gate) before sharing it.
