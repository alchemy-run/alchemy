# Event Hubs telemetry on Azure Functions

A telemetry stream on Azure Event Hubs. A public API function sends device
readings to an event hub, one event or a batch at a time, with the device ID
as the partition key. A worker function consumes the hub in batches through a
native Event Hubs trigger. It writes one result blob per reading, and the API
serves it.

```sh
curl -X POST "$URL/devices/thermostat-1/readings" -d '{"temperature":21.5}'
# 202 {"ids":["5f0c…"],"status":"pending"}
curl -X POST "$URL/devices/thermostat-2/readings" -d '{"temperatures":[20,20.5,21]}'
# 202 {"ids":["9a1b…","c3d4…","e5f6…"],"status":"pending"}
curl "$URL/readings/5f0c…"
# 200 {"id":"5f0c…","deviceId":"thermostat-1","temperature":21.5,"partitionId":"1","sequenceNumber":0,…}
```

## Architecture

- [`Hubs`](./src/resources.ts) — Event Hubs namespace, Standard tier, one
  throughput unit.
- [`Readings`](./src/resources.ts) — event hub with two partitions and
  one-day retention.
- [`Results`](./src/resources.ts) — blob container. One blob per consumed
  reading, at `readings/{id}`.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with a public URL. It
  produces the events.
- [`Worker`](./src/Worker.ts) — `Azure.Functions.Function` with one
  `eventHubTrigger` on `Readings`. It consumes the events.

| Route                               | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `POST /devices/:deviceId/readings`  | send `{ temperature }` or `{ temperatures: [...] }` to `Readings` |
| `GET /readings/:id`                 | the worker's result, `202 pending` until it exists            |

## Bindings and event sources

Both functions run as their system-assigned managed identity. Each binding
assigns one role, on the bound entity only.

| Host   | Binding / event source                                                     | Role, on the entity            |
| ------ | -------------------------------------------------------------------------- | ------------------------------ |
| Api    | `Azure.EventHub.Send(Readings)` + `Azure.EventHub.SendHttp`                | Azure Event Hubs Data Sender   |
| Api    | `Azure.Storage.BlobContainerRead(Results)` + `BlobContainerReadHttp`       | Storage Blob Data Reader       |
| Worker | `Azure.EventHub.consumeEvents(Readings)` + `Azure.Functions.EventHubEventSource` | Azure Event Hubs Data Receiver |
| Worker | `Azure.Storage.BlobContainerWrite(Results)` + `BlobContainerWriteHttp`     | Storage Blob Data Contributor  |

Role assignments can take a few minutes to take effect after the first
deploy. Until then the API answers `503` with the Azure error.

## Partitions and delivery semantics

The API sends every reading with the device ID as its partition key, so all
readings of one device land in the same partition. Event Hubs keeps the
order inside a partition: the worker sees a device's readings in send order,
with increasing sequence numbers. A batch (`sendBatch`) shares one partition
key, so one request's readings always land together.

The trigger reads the `$Default` consumer group and checkpoints each
partition in the worker's own storage account after the handler returns.
Event Hubs does not redeliver a batch whose handler failed: the checkpoint
moves on. So the worker retries its own writes (for about five minutes) and
logs a reading it still could not record. A reading can arrive twice after
a host restart, before the checkpoint; the worker writes each result with
`put`, so the repeat overwrites its blob with the same values.

## Cost

A Standard namespace with one throughput unit is billed by the hour (about
$0.03 per hour). The two Flex Consumption apps are billed per execution.
One test run costs a few cents, so the test is not gated.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-event-hubs
pnpm deploy --profile <name>
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and reads the event hub through ARM to check its
two active partitions. It sends one reading and a batch of three through the
API, then polls the results until the worker has consumed all of them. It
checks that the batch landed in one partition with sequence numbers in send
order. Then it destroys the stack and checks that the namespace and both
function apps are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
