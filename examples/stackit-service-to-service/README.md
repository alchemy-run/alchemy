# STACKIT service to service

Two `Stackit.Functions.Function`s. A gateway calls a backend through `Stackit.Functions.Invoke`, which finds the backend's URL for you.

```sh
curl "$URL/quote?n=1"
# {"index":1,"quote":"Make it work, make it right, make it fast. — Kent Beck","servedBy":"quotes"}
```

## Architecture

- [`src/Quotes.ts`](./src/Quotes.ts) and [`src/quotes-handler.ts`](./src/quotes-handler.ts): the backend, a plain `fetch` handler in the async form.
- [`src/Gateway.ts`](./src/Gateway.ts): the front door, an Effect program.
- [`src/registry.ts`](./src/registry.ts): the registry project both images go to.

## Bindings

| Host    | Binding                                         | Access                                                                                                                             |
| ------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Gateway | `Stackit.Functions.Invoke(Quotes)` + `InvokeHttp` | Nothing is granted, and no service account is created. The backend's URL reaches the gateway's env, and the request carries only the headers you pass. |

The Functions API has no private network and no invoke permission to set, so nothing here limits who calls `Quotes`. To keep it to the gateway, pass a shared secret in `env` to both, send it as a header from `invoke`, and check it in the handler.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to STACKIT Functions, an alpha API in `eu01` only.

## Cost

STACKIT's price list (v1.0.44) has no Functions SKU. The product page says you pay for what runs. Container Registry is free during its beta. Check the current price list before you leave this deployed.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-service-to-service
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, calls the backend through the gateway, reads both functions through the API, then destroys the stack and checks that both are gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- A function's URL takes requests with no STACKIT token. If it needs one, both this test and `Invoke` need one.
- The API reports a URL once a revision is active. `Invoke` fails with `FunctionUrlMissing` if it never does.
- The functions answer on `8080`, the port Alchemy assumes.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```
