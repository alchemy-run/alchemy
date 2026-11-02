# Async STACKIT Function

A notes API on a `Stackit.Functions.Function` in the async form: a plain `fetch` handler with no Effect, typed with `Stackit.InferEnv`. It stores each note in a bucket through `Bun.S3Client`.

```sh
curl "$URL/"
# hello from an async function
curl -X PUT "$URL/notes/first" -d 'hello'
# 204
curl "$URL/notes/first"
# hello
```

## Architecture

- [`src/resources.ts`](./src/resources.ts): the bucket, an S3 access key, and the function. `env` passes the bucket and the key to the handler, and `NotesEnv` is its type.
- [`src/handler.ts`](./src/handler.ts): the handler. `env` is its second argument, and every value is a string.
- [`src/registry.ts`](./src/registry.ts): the registry project the image goes to.

There is no binding here, so you create the credentials group and the key yourself. A credentials group reaches the project's buckets unless a bucket's `policy` denies it. To limit it, use the Effect form in [`stackit-function`](../stackit-function), whose binding adds those statements for you.

`S3_SECRET_ACCESS_KEY` is a `Redacted` value in the stack and a plain revision variable on the function, so anyone who can call `GetRevision` can read it.

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
cd examples/stackit-function-async
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, calls the handler, reads the revision through the API, stores and reads a note, then destroys the stack and checks that the function and the bucket are gone.

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
