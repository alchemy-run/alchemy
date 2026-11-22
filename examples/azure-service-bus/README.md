# Service Bus queue and topic on Azure Functions

An order queue and an event topic on Azure Service Bus. A public API
function sends orders to the queue and publishes events to the topic. A
worker function consumes the queue and two topic subscriptions through
native Service Bus triggers. It writes one result blob per message, and the
API serves it.

```sh
curl -X POST "$URL/orders" -d '{"item":"widget","quantity":3}'
# 202 {"id":"5f0c…","status":"pending"}
curl "$URL/results/orders/5f0c…"
# 200 {"id":"5f0c…","item":"widget","quantity":3,"deliveryCount":1,"processedAt":"…"}

curl -X POST "$URL/events" -d '{"type":"order.shipped"}'
# 202 {"id":"9a1b…","status":"pending"}
curl "$URL/results/audit/9a1b…"    # the Audit subscription's copy
curl "$URL/results/notify/9a1b…"   # the Notify subscription's copy
```

## Architecture

- [`Bus`](./src/resources.ts) — Service Bus namespace, Standard tier. Topics
  need Standard or higher.
- [`Orders`](./src/resources.ts) — queue. The worker receives each order once.
- [`Events`](./src/resources.ts) — topic with two subscriptions, `Audit` and
  `Notify`. Each subscription gets its own copy of every event.
- [`Results`](./src/resources.ts) — blob container. One blob per processed
  message, at `orders/{id}`, `audit/{id}` or `notify/{id}`.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with a public URL.
- [`Worker`](./src/Worker.ts) — `Azure.Functions.Function` with one
  `serviceBusTrigger` per queue or subscription.

| Route                    | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `POST /orders`           | send `{ item, quantity }` to `Orders`               |
| `POST /events`           | publish `{ type }` to `Events`                      |
| `GET /results/:kind/:id` | the worker's result, `202 pending` until it exists  |

## Bindings and event sources

Both functions run as their system-assigned managed identity. Each binding
assigns one role, on the bound entity only.

| Host   | Binding / event source                                                    | Role, on the entity                     |
| ------ | ------------------------------------------------------------------------- | --------------------------------------- |
| Api    | `Azure.ServiceBus.QueueSend(Orders)` + `QueueSendHttp`                    | Azure Service Bus Data Sender           |
| Api    | `Azure.ServiceBus.TopicWrite(Events)` + `TopicWriteHttp`                  | Azure Service Bus Data Sender           |
| Api    | `Azure.Storage.BlobContainerRead(Results)` + `BlobContainerReadHttp`      | Storage Blob Data Reader                |
| Worker | `Azure.ServiceBus.consumeQueueMessages(Orders)` + `Azure.Functions.ServiceBusQueueEventSource` | Azure Service Bus Data Receiver |
| Worker | `Azure.ServiceBus.consumeSubscriptionMessages(Audit)` and `(Notify)` + `Azure.Functions.ServiceBusSubscriptionEventSource` | Azure Service Bus Data Receiver |
| Worker | `Azure.Storage.BlobContainerWrite(Results)` + `BlobContainerWriteHttp`    | Storage Blob Data Contributor           |

Role assignments can take a few minutes to take effect after the first
deploy. Until then the API answers `503` with the Azure error.

## Delivery semantics

Service Bus delivers at least once. The trigger completes a message when the
handler succeeds and abandons it when the handler fails. After 10 failed
deliveries (the default max delivery count) the message moves to the
dead-letter queue. Redelivery is safe here: the worker writes each result
with `put`, so a repeated message overwrites its blob with the same values.

## Cost

A Standard namespace is billed by the hour (about $0.0135 per hour). The two
Flex Consumption apps are billed per execution. One test run costs a few
cents, so the test is not gated.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-service-bus
pnpm deploy --profile <name>
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack. It sends an order and publishes an event
through the API, then polls the results until the worker has processed the
order and both subscriptions' copies of the event. It reads the queue and
subscription message counts through ARM to check that the worker completed
every message and none was dead-lettered. Then it destroys the stack and
checks that the namespace and both function apps are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
