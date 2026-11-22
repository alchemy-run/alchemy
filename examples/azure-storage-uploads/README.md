# azure-storage-uploads

An upload pipeline on Azure Functions. A public API stores files in Blob
Storage; a second Function picks each upload up from the container's
`BlobCreated` event, hashes it, and records its metadata in Table storage.

```
PUT /files/:name ──> Api ──> <account>/<container>/uploads/:name
                                   │ Microsoft.Storage.BlobCreated
                                   v
                       Event Grid ──> Indexer ──> Table storage files/:name
GET /files ─────────> Api <────────────────────── (size, type, sha256)
```

- `src/resources.ts` — the `Data` storage account, the `Uploads` blob
  container, and the `Files` table.
- `src/Api.ts` — `Azure.Functions.Function` (Flex Consumption) with an
  anonymous HTTP function:
  - `PUT /files/:name` stores the body at `uploads/:name` and returns `202`.
  - `GET /files/:name` returns the stored bytes.
  - `GET /files` lists the indexed metadata.
  - `DELETE /files/:name` deletes the blob and its metadata.
- `src/Indexer.ts` — `Azure.Functions.Function` consuming `BlobCreated`
  events for `uploads/`. It reads the blob, computes its sha256, and
  upserts the `files` row. Uploads never wait on the hash.

## Bindings and event sources

| Host    | Binding / event source                              | Role granted to the app's managed identity                                  |
| ------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| Api     | `Azure.Storage.BlobContainerReadWrite(uploads)`     | Storage Blob Data Contributor on the container                              |
| Api     | `Azure.Storage.TableReadWrite(files)`               | custom role (entity read, add, update, delete) on the table                 |
| Indexer | `Azure.Storage.BlobContainerRead(uploads)`          | Storage Blob Data Reader on the container                                   |
| Indexer | `Azure.Storage.TableWrite(files)`                   | custom role (entity add, update, delete) on the table                       |
| Indexer | `Azure.Storage.consumeBlobCreated(uploads)`         | none: an Event Grid subscription pushes to the app's `eventGridTrigger`     |

`consumeBlobCreated` is provided by `Azure.Functions.BlobCreatedEventSource`.
It adds a native `eventGridTrigger` function to the Indexer and an Event
Grid subscription on the storage account's system topic, filtered to
`Microsoft.Storage.BlobCreated` with the subject prefix
`/blobServices/default/containers/<container>/blobs/uploads/`. The custom
table roles are one `Azure.Authorization.RoleDefinition` per binding kind
and stack.

## Delivery semantics

Event Grid delivers at least once. A handler that fails (a defect) fails
the invocation, and Event Grid retries it with backoff for up to 24 hours.
Right after the first deploy the Indexer's data roles may not have
propagated yet; the handler retries those 403s (typed
`SchemaRegistryStorageAccessDenied` / `TablePermissionDenied`) for about
25 seconds before it gives the event back to Event Grid.
The Indexer upserts each row, so a redelivered event rewrites it with the
same values. If the blob is gone by the time the event arrives, the
Indexer skips it.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and
pick Azure, then deploy with `--profile <name>`.

```sh
pnpm install
cd examples/azure-storage-uploads
pnpm deploy --profile <name>
```

```sh
curl -X PUT --data-binary @photo.jpg -H 'content-type: image/jpeg' "$url/files/photo.jpg"
curl "$url/files"            # metadata appears once the indexer has run
curl -o out.jpg "$url/files/photo.jpg"
curl -X DELETE "$url/files/photo.jpg"
```

On a fresh deploy the data roles take a minute or two to propagate. Until
then the API answers `500` and the Indexer's writes fail (Event Grid
redelivers them), so metadata shows up late rather than never.

## Cost

Two Flex Consumption apps (billed per execution), three Standard_LRS
storage accounts (the data account and one per app), and Event Grid
deliveries: a few cents per test run. The test is not gated.

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, checks the container, table, Event Grid subscription,
and each app's role assignments out of band through ARM, uploads a text
file and a random binary, reads both back, waits for the Indexer's rows and
checks each sha256 against the uploaded bytes, deletes a file, then
destroys the stack and checks the storage account and both function apps
are gone. On a fresh deploy the first `BlobCreated` delivery can be lost
or delayed by Event Grid's backoff, so the test re-uploads a file that is
not indexed after 2 minutes (up to 6 times).

## Destroy

```sh
pnpm destroy --profile <name>
```

Destroy deletes the container and every blob in it.
