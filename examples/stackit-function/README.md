# STACKIT Function with Object Storage

A file store on a `Stackit.Functions.Function`, in the Effect-native form. The function keeps each file as an object in a `Stackit.ObjectStorage.Bucket`.

```sh
curl -X PUT "$URL/files/hello.txt" -d 'hello'
# 204
curl "$URL/files/hello.txt"
# hello
curl "$URL/files"
# {"keys":["hello.txt"]}
curl -X DELETE "$URL/files/hello.txt"
# 204
```

## Architecture

- [`Files`](./src/resources.ts): the bucket.
- [`Api`](./src/Api.ts): the function. Alchemy builds its image with Docker on your machine and pushes it to the registry project in [`src/registry.ts`](./src/registry.ts).

## Bindings

| Host | Binding                                                                         | Access                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.ObjectStorage.ReadWriteBucket(Files)` + `ReadWriteBucketHttp`          | A credentials group and access key for this function. Statements in the bucket's policy limit the group to read and write actions there. The key reaches the function as a revision variable. |

A revision variable is plain text to anyone who can call `GetRevision`, including this key. A bucket policy only speaks for its own bucket, so give your other buckets a `policy` that denies this group if it shouldn't reach them.

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
cd examples/stackit-function
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, stores and reads a file over HTTP, reads the object back from the bucket with its own access key, then destroys the stack and checks that the function and the bucket are gone.

## What to check on your first deploy

This example has not run against STACKIT yet. STACKIT documents no container contract for Functions, so check:

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
