# Azure Functions and Storage under `alchemy dev`

One Effect-native Azure Function with a blob container, a Storage queue,
and a queue consumer. `alchemy dev` runs it on your machine: the Function
is a local Node.js process, and Storage runs on
[Azurite](https://github.com/Azure/Azurite) in Docker. `alchemy deploy`
runs the same code on Flex Consumption with real Azure Storage.

```sh
pnpm dev
# api: 'http://localhost:41237'
curl "$API/"
# {"marker":"azure-dev-marker-v1","variable":"my-variable-abc123"}
curl "$API/blob"
# {"text":"hello from blob storage"}
curl -X POST "$API/queue/send" -d '{"id":"1","text":"hi"}'
curl "$API/queue/messages?id=1"
# {"body":"{\"id\":\"1\",\"text\":\"hi\"}"}
```

Edit `src/marker.ts` while `alchemy dev` runs: the Function restarts with
the new code on the same URL.

## Architecture

- [`Storage`](./src/Storage.ts) — a storage account, a blob container, and a
  queue.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` in the Effect form,
  with `Azure.Storage.BlobContainerReadWrite`, `Azure.Storage.QueueSend`,
  and `Azure.Storage.consumeQueueMessages`.
- [`alchemy.run.ts`](./alchemy.run.ts) — the stack.

| Route                     | What it does                                  |
| ------------------------- | --------------------------------------------- |
| `GET /`                   | the marker and `MY_VARIABLE`                  |
| `GET /blob`               | write `hello.txt` and read it back            |
| `POST /queue/send`        | send the body to the queue                    |
| `GET /queue/messages?id=` | the record the consumer wrote for message `id` |

## What runs where

| Resource                    | `alchemy dev`                                     | `alchemy deploy`                     |
| --------------------------- | ------------------------------------------------- | ------------------------------------ |
| `Azure.Functions.Function`  | `node index.mjs` on `http://localhost:<port>`     | Flex Consumption function app        |
| `Azure.Storage.StorageAccount` | Azurite's `devstoreaccount1`                   | Standard_LRS account                 |
| `Azure.Storage.BlobContainer`  | container in Azurite                           | container in the account             |
| `Azure.Storage.Queue`          | queue in Azurite                               | queue in the account                 |
| Queue consumer              | the local runtime polls the queue                 | the Functions host's `queueTrigger`  |
| Resource group              | none                                              | `<stack>-<stage>`                    |

Under `alchemy dev` no Azure call runs and no Azure credentials are
needed. Alchemy starts Azurite as the Docker container `alchemy-azurite`
(ports 10100-10102) and keeps it running between sessions. Local Storage
calls are signed with Azurite's public development key.

Limits of the local runtime:

- Bindings attach no role assignments, and only Storage queue and timer
  triggers run. Event Grid, Service Bus, Event Hubs, Cosmos DB, and Durable
  Task triggers log a warning.
- A local Function reaches only local Storage. To use a cloud resource, run
  the Function and the resource remotely with `Alchemy.remote()`.

## Cost

`alchemy dev` is free. A deploy creates one Flex Consumption app (billed
per execution, scales to zero) and two Standard_LRS storage accounts (the
data account and the Functions host account). One live test run costs about
a cent.

## Run locally

Start Docker. From the repository root:

```sh
pnpm install
cd examples/azure-dev
pnpm dev
```

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup).

```sh
pnpm deploy --profile <name>
```

## Tests

```sh
bun test test/dev.test.ts                              # alchemy dev, needs Docker only
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts     # live Azure
```

`dev.test.ts` spawns the real CLI with an empty Alchemy home (no Azure
credentials). It checks the localhost URL and the `dev:` identities, the
blob roundtrip (and the blob in Azurite), the queue message reaching the
consumer, and a restart after `src/marker.ts` changes. Then it destroys the
stack and checks the container and the queue are gone from Azurite.

`integ.test.ts` deploys the same stack to Azure and drives the same routes.
It reads the blobs out of band with an account SAS, then destroys the stack
and checks the function app and the storage account are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
