# Scheduled work on Azure Functions

An Azure Function with two timer schedules that write blobs, and two public routes that read them back.

```sh
curl "$URL/heartbeats?limit=2"
# 200 {"heartbeats":[{"at":"2026-10-25T09:31:00.012Z","isPastDue":false},{"at":"2026-10-25T09:30:00.009Z","isPastDue":false}]}
curl "$URL/reports?limit=1"
# 200 {"reports":[{"at":"2026-10-25T00:00:00.015Z","heartbeats":1440}]}
```

## Architecture

- [`Monitor`](./src/Monitor.ts): an `Azure.Functions.Function` (Flex Consumption, Node.js 22).
  - `Heartbeat` runs every minute (`0 * * * * *`). It writes `heartbeats/<time>.json`.
  - `DailyReport` runs daily at 00:00 UTC (`0 0 0 * * *`). It counts the heartbeats of the last 24 hours and writes `reports/<date>.json`.
  - `GET /heartbeats?limit=N` and `GET /reports?limit=N` return the newest blobs first (at most 20).
- [`Runs`](./src/resources.ts): the blob container, in the `Data` storage account.

Schedules are NCRONTAB expressions with six fields, seconds first, in UTC.

## Bindings and event sources

| Binding / event source | What Alchemy sets up |
| --- | --- |
| `Azure.Functions.schedule(name, cron, handler)` (×2) | One native `timerTrigger` function per schedule, named `timer-<name>`. The Functions host fires it, so no loop runs in the program and one instance runs each occurrence. |
| `Azure.Storage.BlobContainerReadWrite(Runs)` + `BlobContainerReadWriteHttp` | **Storage Blob Data Contributor** on the container, assigned to the function app's managed identity |

A new role assignment can take a minute or two to propagate. Until then the read routes and the first heartbeats can fail.

## Deploy

Set up an Azure service principal and profile first. See [Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-schedule
pnpm deploy --profile <name>
```

Use the printed `url`. A heartbeat appears within a minute. To run a schedule now, call the Functions host's admin API with the app's master key:

```sh
KEY=$(az functionapp keys list -g <resourceGroup> -n <functionApp> --query masterKey -o tsv)
curl -X POST "https://<hostName>/admin/functions/timer-DailyReport" \
  -H "x-functions-key: $KEY" -H "content-type: application/json" -d '{"input":""}'
# 202
```

## Cost

One Flex Consumption app (billed per execution) and one Standard_LRS storage account. A test run costs well under $0.01. Left deployed, the minute heartbeat runs about 43,000 times a month; check the [Flex Consumption pricing](https://azure.microsoft.com/pricing/details/functions/) before you leave it running.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test
```

The test deploys the stack and checks that ARM lists one `timerTrigger` function per schedule. It waits for a heartbeat newer than the test, forces one run of `DailyReport` through the admin API, and reads both blobs out of band through a service SAS. Then it destroys the stack and checks the function app and storage account are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
