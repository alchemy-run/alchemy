# Cosmos DB for NoSQL on Azure Functions

A todo API on a serverless Cosmos DB for NoSQL account. The API function
reads and writes todos through Cosmos DB bindings. A worker function reads
the container's change feed through a native Cosmos DB trigger and records
the latest version of each changed todo, which the API serves.

```sh
curl -X POST "$URL/todos/alice" -d '{"title":"buy milk"}'
# 201 {"todo":{"id":"5f0c…","owner":"alice","title":"buy milk","done":false},"etag":"\"0d00…\""}
curl -X PATCH "$URL/todos/alice/5f0c…" -H 'If-Match: "0d00…"' -d '{"done":true}'
# 200 {"todo":{…,"done":true},"etag":"\"0e00…\""}   (412 if the etag is stale)
curl "$URL/todos/alice"
# 200 {"todos":[…]}
curl "$URL/changes/alice/5f0c…"
# 200 {"change":{…,"done":true,"version":"\"0e00…\"","changedAt":1793…}}
```

## Architecture

- [`Account`](./src/resources.ts) — Cosmos DB account, serverless, in
  `centralus`.
- [`Database`](./src/resources.ts) — SQL database.
- [`Todos`](./src/resources.ts) — container, partitioned by `/owner`.
- [`Changes`](./src/resources.ts) — container, partitioned by `/owner`. One
  document per todo: the latest version the worker saw on the change feed.
- [`Leases`](./src/resources.ts) — container for the change feed's
  checkpoints, partitioned by `/id`.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with a public URL.
- [`Worker`](./src/Worker.ts) — `Azure.Functions.Function` with one
  `cosmosDBTrigger` on `Todos`.

| Route                       | What it does                                              |
| --------------------------- | --------------------------------------------------------- |
| `POST /todos/:owner`        | create `{ title }`                                        |
| `GET /todos/:owner`         | the owner's todos (one query page)                        |
| `GET /todos/:owner/:id`     | one todo and its etag                                     |
| `PATCH /todos/:owner/:id`   | set `{ title?, done? }`; `If-Match` makes it conditional  |
| `DELETE /todos/:owner/:id`  | delete the todo                                           |
| `GET /changes/:owner/:id`   | the worker's record, `202 pending` until it exists        |

## Bindings and event sources

Both functions run as their system-assigned managed identity. Cosmos DB
data roles are Cosmos DB role assignments, separate from Azure RBAC. Each
binding assigns one, on its container only.

| Host   | Binding / event source                                                      | Cosmos DB data role, scope                         |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Api    | `Azure.CosmosDB.SqlContainerReadWrite(Todos)` + `SqlContainerReadWriteHttp` | custom: read, query, create, upsert, replace, delete; `Todos` |
| Api    | `Azure.CosmosDB.SqlContainerRead(Changes)` + `SqlContainerReadHttp`         | Cosmos DB Built-in Data Reader; `Changes`          |
| Worker | `Azure.CosmosDB.consumeChangeFeed(Todos, { leases })` + `Azure.Functions.CosmosDBChangeFeedEventSource` | Cosmos DB Built-in Data Contributor; the database (the trigger also writes `Leases`) |
| Worker | `Azure.CosmosDB.SqlContainerWrite(Changes)` + `SqlContainerWriteHttp`       | custom: create, upsert, replace, delete; `Changes` |

Data roles can take about 6 minutes to apply after the first deploy. Until
then the API answers `503` with the Cosmos DB error, and the change-feed
trigger does not start.

## Change feed semantics

The change feed holds the latest version of each created or updated
document. Several updates to one todo can arrive as one version, and
deletes are not in the feed. The trigger starts from the beginning of the
feed on its first run (`startFromBeginning: true`), so todos written before
the trigger started are not skipped. The worker upserts each version into
`Changes`, so a repeated batch writes the same document again.

## Cost

A serverless account is billed per request unit and costs nothing while
idle. The two Flex Consumption apps are billed per execution. One test run
costs a few cents, so the test is not gated.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-cosmos
pnpm deploy --profile <name>
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and reads each app's Cosmos DB role assignments
through ARM to check their scopes. It creates, reads, lists, updates and
deletes a todo through the API, and checks that a stale `If-Match` etag
gets a `412`. Then it creates and updates a todo and polls until the worker
has recorded both versions from the change feed. Then it destroys the stack
and checks that the account and both function apps are gone. A run takes
about 20 minutes: the change-feed trigger needs about 5 minutes to start
after a fresh deploy, and the account delete about 8 minutes.

## Destroy

```sh
pnpm destroy --profile <name>
```
