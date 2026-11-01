# TanStack Start on Cloudflare with Convex

A TanStack Start site on Cloudflare that reads live data from Convex through `convex/react`.

| Folder | Holds |
| --- | --- |
| `apps/web` | The site, deployed as a Cloudflare Worker |
| `packages/backend` | The Convex functions |

`alchemy.run.ts` creates a Convex project and a deployment, pushes the functions, creates keys for CI, and passes the deployment's URL to the Worker.

## Deploy

You need a Convex team access token and Cloudflare credentials.

```bash
pnpm install
pnpm alchemy deploy --stage dev
```

Open the `websiteUrl` it prints and click "Add a message". The row appears through the Convex websocket.

The `prod` stage uses a prod deployment. Every other stage gets its own preview.

## Destroy

```bash
pnpm alchemy destroy --stage dev
```

This removes the Worker, the stage's preview and the project. The `prod` stage keeps its project, and its deployment has `deletionProtection` on.
