# Effect Container App on Azure

A notes API written as an Effect program and run on Azure Container Apps.
Alchemy bundles the program, pushes it as an image to an Azure Container
Registry it creates (no Docker needed), and runs it with a system-assigned
managed identity. A blob binding stores each note in a Storage container.

```sh
curl -X PUT "$URL/notes/hello" --data "hi there"
# 201 stored
curl "$URL/notes/hello"
# 200 hi there
```

## Architecture

- [`Environment`](./src/resources.ts) — `Azure.ContainerApps.ManagedEnvironment`
  with one Consumption workload profile (no reserved cores).
- [`Notes`](./src/resources.ts) — `Azure.Storage.BlobContainer` in a
  Storage account.
- [`Api`](./src/Api.ts) — `Azure.ContainerApps.ContainerApp` in its Effect
  form: `main: import.meta.url`, an init Effect that binds
  `Azure.Storage.BlobContainerReadWrite(Notes)`, and a `fetch` handler.
  The binding grants the app's managed identity **Storage Blob Data
  Contributor** on the `Notes` container only. The app scales to zero
  between requests.

| Route              | What it does                          |
| ------------------ | ------------------------------------- |
| `GET /`            | answers `ok`                          |
| `PUT /notes/:key`  | stores the body as the blob `notes/<key>` |
| `GET /notes/:key`  | returns the note, or `404`            |

Every resource runs in `westus2`. All resources go in the stack's resource
group (`<stack>-<stage>`).

## Cost and time

A few cents per run: the Consumption environment is free while idle, the
0.25 vCPU app scales to zero, and the Basic registry and the Storage account
bill by the hour and by use. The environment takes 3-9 minutes to create
and up to ~26 minutes to delete, so a full test run takes about 45 minutes.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-container-app
pnpm deploy --profile <name>
```

The stack outputs the app's URL.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, calls the API over HTTPS, stores a note and
reads it back, then checks out of band that the app runs the pushed image
with a system-assigned identity that holds exactly one role assignment:
Storage Blob Data Contributor on the container. It then destroys the stack
and checks the app and the environment are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
