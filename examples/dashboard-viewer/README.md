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

The viewer needs the state store's endpoint and bearer token. If you
deploy with `Cloudflare.state()`, both are cached at
`~/.alchemy/credentials/{profile}/cloudflare-state-store` after any deploy:

```sh
export ALCHEMY_STATE_URL="https://alchemy-state-store.<subdomain>.workers.dev"
export ALCHEMY_STATE_TOKEN="<authToken from the credentials file>"
```

Optional:

```sh
export ALCHEMY_VIEWER_STACK="MyStack"   # default: first stack in the store
export ALCHEMY_VIEWER_STAGE="prod"      # default: first stage of the stack
export ALCHEMY_DASHBOARD_DIST=".../dist" # default: ../../packages/dashboard/dist
```

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
