# Effect workflows on Azure Durable Functions

An order workflow written with `effect/workflow`, run on Azure Durable
Functions with a Durable Task Scheduler task hub as its backend. An API
function starts runs, reads them, approves them, and cancels them.

```sh
curl -X POST "$URL/orders/o-1?quantity=2"
# 202 {"executionId":"9f2c…"}
curl -X POST "$URL/runs/9f2c…/approve?by=alice"
curl "$URL/runs/9f2c…"
# 200 {"_tag":"Completed","result":"charged o-1, approved by alice"}
```

## Architecture

- [`PlaceOrder`](./src/orders.ts) — the workflow: reserve stock (released
  again if the order fails), wait for an `Approval` signal, sleep durably,
  then charge. An order over 5 items is `Declined`.
- [`OrderWorkflows`](./src/OrderWorkflows.ts) — `Azure.Functions.WorkflowFunction`
  that hosts `PlaceOrder`. Alchemy creates its Durable Task Scheduler
  (Consumption tier) and task hub, and grants the function's managed
  identity **Durable Task Data Contributor** on the hub.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with
  `Azure.Functions.DurableEngine(OrderWorkflows)`, which grants it the same
  role and starts, reads, signals and interrupts runs in the task hub.

| Route                                | What it does                     |
| ------------------------------------ | -------------------------------- |
| `POST /orders/:orderId?quantity=n`   | start a run (one per `orderId`)  |
| `GET /runs/:executionId`             | the run's status                 |
| `POST /runs/:executionId/approve?by` | send the `Approval` signal       |
| `POST /runs/:executionId/cancel`     | interrupt the run                |

Durable Task Schedulers are offered in fewer regions than Functions (not
`eastus`), so the whole example runs in `westus2`.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-effect-workflows
pnpm deploy --profile <name>
```

The stack outputs the API URL and the task hub's Durable Task Scheduler
dashboard URL, where every run shows its steps.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks the workflow function and task hub exist,
runs an approved order, a declined order and a cancelled order through the
API, then destroys the stack and checks the task hub and function app are
gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
