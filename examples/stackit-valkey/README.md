# Key Value Store from a STACKIT Function

A hit counter on a `Stackit.Functions.Function`, counting in a `Stackit.Valkey.Instance` over the Redis protocol.

```sh
curl -X POST "$URL/hit/home"
# {"key":"home","count":1}
curl "$URL/count/home"
# {"key":"home","count":1}
```

## Architecture

- [`src/resources.ts`](./src/resources.ts): a single-node instance, and a `Stackit.Valkey.Credential` holding its user and password.
- [`src/Api.ts`](./src/Api.ts): the function.
- [`src/registry.ts`](./src/registry.ts): the registry project the image goes to.

## Bindings

| Host | Binding                                                  | Access                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.Valkey.ReadWriteValkey(App)` + `ReadWriteValkeyHttp` | No STACKIT role and no service account. Commands authenticate with the credential, and STACKIT's API has no Valkey ACLs, so it can do everything on the server. Its URI reaches the function as a plain revision variable. |

## The ACL

The instance only takes connections from its `acl`, and a Function has no fixed egress address, so this example sets `acl: ["0.0.0.0/0"]`. Use a narrower one once your hosts have known addresses.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to STACKIT Functions, an alpha API in `eu01` only.

## Cost

The instance bills per started hour for as long as it exists. Check the current price list for the Key Value Store price. Comparable single-node STACKIT data services run about **EUR 0.10-0.12 per hour**. STACKIT's price list (v1.0.44) has no Functions SKU; the product page says you pay for what runs. Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-valkey
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, pings the instance and counts hits over HTTP, reads the instance through the API, then destroys the stack and checks that the instance is gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- `version: "x"` and `planName: "stackit-keyvalue-1.2.10-single"`. A wrong name fails the deploy with `DataServicePlanNotFound`, which lists the choices.
- The credential's URI has a `redis://`, `rediss://`, `valkey://` or `valkeys://` scheme. Any other fails each command with `UrlMissing`.
- The function answers on `8080`, the port Alchemy assumes, and its URL takes requests with no STACKIT token.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```
