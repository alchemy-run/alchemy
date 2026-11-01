# Effect HTTP API on a STACKIT Function

A task API built with Effect's `HttpApi` on a `Stackit.Functions.Function`. The schema validates requests and responses, and an unknown task is a 404.

```sh
curl -X POST "$URL/tasks" -H 'content-type: application/json' -d '{"title":"write docs"}'
# {"id":"5f0c…","title":"write docs"}
curl "$URL/tasks/5f0c…"
# {"id":"5f0c…","title":"write docs"}
```

## Architecture

- [`src/TaskApi.ts`](./src/TaskApi.ts): the API as a plain value. A server and a typed client can both import it.
- [`src/Api.ts`](./src/Api.ts): the function. `HttpRouter.toHttpEffect` turns the API into its `fetch`.
- [`src/resources.ts`](./src/resources.ts): the bucket holding the tasks.
- [`src/registry.ts`](./src/registry.ts): the registry project the image goes to.

## Bindings

| Host | Binding                                                                | Access                                                                                                                                 |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.ObjectStorage.ReadWriteBucket(Tasks)` + `ReadWriteBucketHttp` | A credentials group and access key for this function. Statements in the bucket's policy limit the group to read and write actions there. |

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to STACKIT Functions, an alpha API in `eu01` only.

## Cost

STACKIT's price list (v1.0.44) has no Functions SKU. The product page says you pay for what runs. Object Storage bills what you store. Container Registry is free during its beta. Check the current price list before you leave this deployed.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-httpapi
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, creates and reads a task over HTTP, checks the 404 and the 400, then destroys the stack and checks that the function and the bucket are gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- The function answers on `8080`, the port Alchemy assumes.
- A new `ACTIVE` revision becomes the function's current revision by itself.
- `CreateRevision` accepts variables with no variable definition on the function.
- The function's URL takes requests with no STACKIT token.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```
