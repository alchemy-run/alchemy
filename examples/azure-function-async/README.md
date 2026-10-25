# Azure Function (async) Example

An `Azure.Functions.Function` with a plain `fetch` handler: no Effect in the
runtime code. The handler stores notes in a private blob container and reads
them back with the app's managed identity.

- [`alchemy.run.ts`](./alchemy.run.ts) — a storage account and blob
  container, the Function (`main: "./src/api.ts"` and no implementation),
  and an `Azure.Authorization.RoleAssignment` that grants the Function's
  managed identity Storage Blob Data Contributor on the container.
  `Azure.InferEnv<typeof Api>` types the handler's `env`.
- [`src/api.ts`](./src/api.ts) — default-exports `{ fetch(request, env) }`.
  `env.GREETING` is a `Config` value; `env.NOTES` arrives as the container's
  attributes (`storageAccount`, `containerName`, …). The handler gets a
  storage token from the Functions identity endpoint and calls the Blob REST
  API with `fetch`.

| Route               | What it does                       |
| ------------------- | ---------------------------------- |
| `GET /`             | the greeting                       |
| `PUT /notes/:name`  | store the request body as a blob   |
| `GET /notes/:name`  | read the blob back (404 if absent) |

An async Function has no bindings, so it grants its own role. The Effect
form (`Azure.Functions.Function<Self>()(...)` with
`Azure.Storage.BlobContainerReadWrite`) grants the role and hands you a typed
client instead.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-function-async
pnpm deploy --profile <name>
```

Set `GREETING` to change the greeting (default `hello`). Everything goes into
the stack's resource group, `AzureFunctionAsyncExample-<stage>`.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks the function app and its role assignment
through ARM, stores and reads a note over HTTP, then destroys the stack and
checks the app and the role assignment are gone. It costs a few cents (Flex
Consumption bills per execution) and takes about 2 minutes. The blob role
can take a few minutes to propagate after the first deploy; the test retries
until it does.

## Destroy

```sh
pnpm destroy --profile <name>
```
