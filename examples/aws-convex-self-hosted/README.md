# Self-hosted Convex on AWS

A TanStack Start site reading live data from a self-hosted Convex backend, with one shared platform per AWS account.

| File | Deployed | Holds |
| --- | --- | --- |
| `stacks/platform.ts` | Once per account | VPC, ECS cluster, load balancer, Postgres, buckets |
| `alchemy.run.ts` | Once per stage | Backend service, its database and hosts, the site |

Stages other than `prod` share the development account's platform. `prod` uses the production account's platform.

## Deploy

You need Docker running, and a Route 53 hosted zone for your domain in the account.

```bash
pnpm install
export CONVEX_DOMAIN=dev.example.com
pnpm alchemy deploy stacks/platform.ts --stage dev --profile dev --yes
pnpm alchemy deploy --stage alice --profile dev --yes
```

Open the `websiteUrl` it prints and click "Add a message". The row appears through the Convex websocket.

A stage gets `alice-cloud.dev.example.com` and `alice-site.dev.example.com`, with its own database and its own prefix in the buckets.

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

Destroying a stage drops its database and deletes its bucket prefix. Other stages keep running.
