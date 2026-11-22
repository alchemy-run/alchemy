# Effect HttpApi on Azure Functions

A job API written with `effect/http-api` and served by an
`Azure.Functions.Function` (Flex Consumption). Jobs live in Azure Table
storage. One `JobApi` value is the server's contract and the client's:
the test calls the deployed app through `HttpApiClient.make(JobApi)`.

```sh
curl -X POST "$URL/jobs" -H 'content-type: application/json' -d '{"content":"hello"}'
# 201 {"id":"5f0c…","content":"hello","createdAt":"2026-…"}
curl "$URL/jobs/5f0c…"
# 200 {"id":"5f0c…","content":"hello","createdAt":"2026-…"}
curl "$URL/jobs/nope"
# 404 {"_tag":"JobNotFound","id":"nope"}
```

## Architecture

- [`JobApi`](./src/JobApi.ts) — the `HttpApi`: endpoints, payload and
  success schemas, and typed errors (`JobNotFound` is a 404,
  `JobStoreUnavailable` a 503).
- [`JobApiLive`](./src/JobApiLive.ts) — the handlers. They depend on the
  `JobStorage` service, not on Azure.
- [`JobStorage`](./src/JobStorage.ts) — `JobStorageTable` implements it on
  the `Jobs` table with `Azure.Storage.TableReadWrite` +
  `TableReadWriteHttp`.
- [`JobFunction`](./src/JobFunction.ts) — `Azure.Functions.Function`.
  `HttpRouter.toHttpEffect(JobApiLive)` becomes its `fetch`.
- [`Data` and `Jobs`](./src/resources.ts) — a Standard_LRS storage account
  and the table. Both go into the stack's resource group,
  `AzureFunctionHttpApiExample-<stage>`.

| Route              | What it does              |
| ------------------ | ------------------------- |
| `POST /jobs`       | create a job (`201`)      |
| `GET /jobs/:id`    | read a job, or `404`      |
| `GET /jobs`        | list jobs (one page)      |
| `DELETE /jobs/:id` | delete a job (`204`)      |
| `GET /health`      | `"ok"`                    |

## Bindings

| Host        | Binding                                                    | Role granted to the app's managed identity                                                    |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| JobFunction | `Azure.Storage.TableReadWrite(Jobs)` + `TableReadWriteHttp` | custom role `AzureStorageTableReadWriteRole` (read, add, update, delete entities), on the `Jobs` table only |

A new role assignment can take a few minutes to reach the Table storage
data plane. Until then the API answers `503 JobStoreUnavailable` with
`reason: "TablePermissionDenied"`.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-function-httpapi
pnpm deploy --profile <name>
```

The stack outputs the API URL. The first request after a deploy or an idle
period waits a few seconds for a Flex Consumption instance to start.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks the function app and the table exist,
then uses the typed client to create, read, list, and delete a job. It
checks the Table storage entity out of band with an account SAS, checks a
bad payload gets a `400` and an unknown job a `404`. Then it destroys the
stack and checks the function app, table, storage account, and resource
group are gone. A run costs about $0.01 and takes 2 to 8 minutes, most of it
the deploy and the role propagation.

## Destroy

```sh
pnpm destroy --profile <name>
```
