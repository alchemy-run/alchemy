# Scheduled job on Azure Container Apps

A report that builds itself on a schedule. An API on Azure Functions stores
files in a blob container; a Container Apps job runs every minute, sums the
files, and writes a report the API serves.

```sh
curl -X PUT "$URL/files/a.txt" --data "hello"
# 201 {"name":"a.txt","bytes":5}
curl "$URL/report"
# 404 no report yet   (until the next execution)
# 200 {"execution":"reportjob-…-x1y2z3","files":1,"bytes":5,"generatedAt":"…"}
```

## Architecture

- [`Env`](./src/resources.ts) — `Azure.ContainerApps.ManagedEnvironment` with
  a Consumption workload profile. Jobs need a standard environment (not
  `Express`).
- [`Bucket`](./src/resources.ts) — a blob container in the `Data` storage
  account: uploads under `files/`, reports under `reports/`.
- [`ReportJob`](./src/ReportJob.ts) — `Azure.ContainerApps.Job`.
  `Azure.ContainerApps.schedule(SCHEDULE, …)` makes it a `Schedule` job, and
  each execution runs the handler once and exits. Alchemy bundles the file for
  Node.js and builds its image in a Basic container registry it creates for
  the job, without Docker.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` (Flex Consumption).
  `PUT /files/:name` stores a file, `GET /report` returns
  `reports/latest.json`.

`SCHEDULE` is `"* * * * *"` (every minute, UTC) so a fresh deploy shows a
report quickly. Change it to `"0 2 * * *"` for a nightly report.

## Bindings

| Host      | Binding                                                                   | Role granted to the host's managed identity      |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| ReportJob | `Azure.Storage.BlobContainerReadWrite(Bucket)` + `BlobContainerReadWriteHttp` | **Storage Blob Data Contributor** on `Bucket` |
| ReportJob | its image registry (automatic)                                            | **AcrPull** on the job's registry                |
| Api       | `Azure.Storage.BlobContainerReadWrite(Bucket)` + `BlobContainerReadWriteHttp` | **Storage Blob Data Contributor** on `Bucket` |

Role assignments take a few minutes to propagate after the first deploy.
Until then the job's executions fail and the API answers `500`; the next
execution on the schedule succeeds.

## Cost

Below $1 per test run, so the test is not gated: the Consumption environment
has no idle cost, the Basic registry is about $0.17 per day, and the Flex
Consumption function and the 0.25 vCPU executions stay inside the monthly
free grants. While deployed, the job runs 1,440 times a day; destroy the
stack, or change `SCHEDULE`, when you are done.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-container-app-job
pnpm deploy --profile <name>
```

Creating the Container Apps environment takes 5 to 30 minutes.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and checks out of band that the job is a
`Schedule` job on `SCHEDULE` with a system-assigned identity. It uploads
three files through the API, waits for a report that counts them, and checks
that the execution which wrote the report succeeded. Then it destroys the
stack and checks that the job, the environment, and the storage account are
gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
