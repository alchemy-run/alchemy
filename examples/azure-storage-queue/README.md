# Azure Storage queue: producer and consumer

A job queue on Azure Storage. An API function enqueues jobs; a worker
function consumes them through a `queueTrigger` event source and writes each
result to a blob container, where the API reads it back.

```sh
curl -X POST "$URL/jobs" -H 'content-type: application/json' -d '{"payload":"hello world"}'
# 202 {"id":"9f2c…","status":"pending"}
curl "$URL/jobs/9f2c…"
# 200 {"id":"9f2c…","status":"done","sha256":"b94d…","words":2,"chars":11,…}
```

## Architecture

```
POST /jobs ──> Api ──QueueSend──> Jobs queue ──queueTrigger──> Worker
GET /jobs/:id ──> Api <──BlobContainerRead── Results container <──BlobContainerWrite──┘
```

- [`resources.ts`](./src/resources.ts) — a storage account with the `Jobs`
  queue and the `Results` blob container.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with an HTTP handler.
  `Azure.Storage.QueueSend` grants its managed identity **Storage Queue Data
  Message Sender** on the queue; `Azure.Storage.BlobContainerRead` lets it
  read results.
- [`Worker`](./src/Worker.ts) — `Azure.Functions.Function` with no HTTP
  handler. `Azure.Storage.consumeQueueMessages` (provided by
  `Azure.Functions.StorageQueueEventSource`) adds a native `queueTrigger`
  function and grants **Storage Queue Data Reader** and **Storage Queue Data
  Message Processor** on the queue. A failed message is retried; after five
  dequeues it moves to `<queue name>-poison`.

| Route           | What it does                                       |
| --------------- | -------------------------------------------------- |
| `POST /jobs`    | enqueue `{ payload }`, answer `202 { id }`         |
| `GET /jobs/:id` | `200` with the result, or `202` while it's pending |

Every resource goes into the stack's resource group,
`AzureStorageQueueExample-<stage>`, which Alchemy creates on deploy and
deletes on destroy. Resources default to the profile's location (then
`eastus`).

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-storage-queue
pnpm deploy --profile <name>
```

The stack outputs the API URL. The first requests after a deploy can answer
`503` for a minute or two while the apps' data roles propagate.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks each app's managed identity holds only
the queue roles its bindings ask for, sends five jobs through the API and
waits for their results, then destroys the stack and checks the apps, queue
and container are gone. It costs a few cents (two Flex Consumption apps
billed per execution, three Standard_LRS storage accounts) and takes about
10 minutes.

## Destroy

```sh
pnpm destroy --profile <name>
```
