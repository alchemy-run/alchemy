# Self-hosted Convex on AWS

A TanStack Start site reading live data from a self-hosted Convex backend, with one shared platform per AWS account.

| File | Deployed | Holds |
| --- | --- | --- |
| `stacks/platform.ts` | Once per account | VPC, ECS cluster, load balancer, buckets, and Postgres in production |
| `alchemy.run.ts` | Once per stage | Backend service, its data and hosts, the site |

Stages other than `prod` are previews on the development account's platform, and keep their data in SQLite, so the development platform runs no database server. `prod` uses the production account's platform and its Postgres.

## Deploy

You need a Route 53 hosted zone for your domain in the account. Docker isn't needed.

```bash
pnpm install
export CONVEX_DOMAIN=previews.example.com
pnpm alchemy deploy stacks/platform.ts --stage dev --profile dev --yes
pnpm alchemy deploy --stage alice --profile dev --yes
```

Open the `websiteUrl` it prints and click "Add a message". The row appears through the Convex websocket.

A stage gets `alice.cloud.previews.example.com` and `alice.site.previews.example.com`, with SQLite on its task's disk and its own prefix in the buckets. Once the platform exists, a new stage takes a few minutes. Its data starts over whenever a deploy restarts the backend.

## Production

Deploy the same two files to the production account:

```bash
export CONVEX_DOMAIN=example.com
pnpm alchemy deploy stacks/platform.ts --stage prod --profile production --yes
pnpm alchemy deploy --stage prod --profile production --yes
```

Production gets `cloud.example.com` and `site.example.com`. Its platform has `deletionProtection` on, and so does the `prod` stage's database.

## Destroy

```bash
pnpm alchemy destroy --stage alice --profile dev --yes
pnpm alchemy destroy stacks/platform.ts --stage dev --profile dev --yes
```

Destroying a stage deletes its data and its bucket prefix. Other stages keep running.
