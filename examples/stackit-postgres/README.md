# PostgreSQL Flex from a STACKIT Function

A todo API on a `Stackit.Functions.Function`, on a `Stackit.PostgresFlex.Database`. Each deploy applies the pending files in `migrations/`, and the function connects with Drizzle.

```sh
curl -X POST "$URL/todos" -d '{"title":"apply migrations"}'
# 201 {"id":"5f0c…","title":"apply migrations","done":false}
curl "$URL/todos"
# [{"id":"5f0c…","title":"apply migrations","done":false}]
```

## Architecture

- [`src/resources.ts`](./src/resources.ts): the instance, a user, and a database with `migrations: "./migrations"`.
- [`migrations/`](./migrations): plain `.sql` files, tracked in Alchemy's `__alchemy_migrations` table. Editing or removing an applied file fails the deploy.
- [`src/schema.ts`](./src/schema.ts): the same table for Drizzle.
- [`src/Api.ts`](./src/Api.ts): the function, which opens one pool per request.
- [`src/registry.ts`](./src/registry.ts): the registry project the image goes to.

## Bindings

| Host | Binding                                                       | Access                                                                                                                                                    |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.PostgresFlex.Connect(AppDatabase, AppUser)` + `ConnectHttp` | No STACKIT role and no service account. Connections authenticate with the database user. The password reaches the function as a plain revision variable. |

## The ACL

PostgreSQL Flex only takes connections from the instance's `acl`, and a Function has no fixed egress address. Migrations connect from your machine too, since the service has no SQL API. So this example sets `acl: ["0.0.0.0/0"]`, which STACKIT's docs discourage. Connections still need TLS and the generated password. Use a narrower `acl` once your hosts have known addresses, with your deploying machine's IP as a `/32`.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to STACKIT Functions, an alpha API in `eu01` only.

## Cost

The instance bills per started hour for as long as it exists. Flavor `2.4` is about **EUR 0.13 per hour**, from a snapshot of STACKIT's price page, plus 5 GB of storage and backups per GB. Check the current price list. STACKIT's price list (v1.0.44) has no Functions SKU; the product page says you pay for what runs. Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-postgres
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks the recorded migration and the database's owner through the API, writes and reads a row over HTTP, then destroys the stack and checks that the instance is gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- Flavor `2.4`, version `17` and storage class `premium-perf2-stackit` are orderable on your project.
- The instance's certificate chains to a public root. Migrations verify it, so a private CA fails the connection.
- A new user can log in soon enough. Migrations retry login errors for a few minutes.
- The function answers on `8080`, the port Alchemy assumes, and its URL takes requests with no STACKIT token.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```
