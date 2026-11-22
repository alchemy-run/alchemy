# Azure SQL from an Azure Function

A todo API on Azure Functions (Flex Consumption) backed by an Azure SQL
Database. The Function talks to the database with
[`@effect/sql-mssql`](https://www.npmjs.com/package/@effect/sql-mssql) and
applies the schema with Effect SQL migrations on its first request.

```sh
curl -X POST "$URL/todos" -d '{"title":"write the example"}'
# 201 {"id":"5f0c…","title":"write the example","done":false,"createdAt":"…"}
curl "$URL/todos"
# 200 [{"id":"5f0c…","title":"write the example","done":false,"createdAt":"…"}]
curl -X PATCH "$URL/todos/5f0c…" -d '{"done":true}'
# 200 {"id":"5f0c…","title":"write the example","done":true,"createdAt":"…"}
curl "$URL/migrations"
# 200 [{"id":1,"name":"create_todos"},{"id":2,"name":"index_todos_created_at"}]
```

## Architecture

- [`Sql`](./src/resources.ts) — `Azure.Sql.Server`, the logical server, in
  `centralus`. It has no compute charge.
- [`Todos`](./src/resources.ts) — `Azure.Sql.Database`, Basic tier (5 DTU,
  2 GB) with locally redundant backups.
- [`AllowAzureServices`](./src/resources.ts) — `Azure.Sql.FirewallRule`
  from `0.0.0.0` to `0.0.0.0`, Azure's rule for "allow Azure services".
  Flex Consumption instances have no fixed outbound IP address, so the
  Function needs it. Other clients stay blocked.
- [`SqlAdminPassword`](./src/resources.ts) — `Alchemy.Random`. Alchemy
  generates the administrator password once and keeps it in state.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with a public URL.

| Route                 | What it does                                  |
| --------------------- | --------------------------------------------- |
| `GET /todos`          | every todo, oldest first                      |
| `POST /todos`         | create `{ title }`, `201` with the todo       |
| `GET /todos/:id`      | one todo, `404` if there is none              |
| `PATCH /todos/:id`    | set `{ done }`                                |
| `DELETE /todos/:id`   | delete, `204`                                 |
| `GET /migrations`     | the migrations applied to the database        |

Some subscriptions (free trials) refuse new SQL servers in `eastus`
(`ProvisioningDisabled`). The server and database therefore use
`centralus` (`SQL_LOCATION` in `src/resources.ts`); the Function stays in
the stack's default region.

## Connecting from the Function

Inside the Function, each `yield*` of a resource attribute binds it into
the app's settings and returns an Effect that reads it at runtime:

```ts
const host = yield* server.fullyQualifiedDomainName;
const databaseName = yield* database.databaseName;
const password = yield* passwordOutput;

const SqlLive = Layer.unwrap(
  Effect.gen(function* () {
    const resolvedHost = yield* host;
    const resolvedDatabase = yield* databaseName;
    const resolvedPassword = yield* password;
    return MssqlClient.layer({
      server: resolvedHost,
      database: resolvedDatabase,
      username: ADMIN_LOGIN,
      password: resolvedPassword,
    });
  }),
);
```

`fetch` provides `SqlLive` per request, so each request opens its own
connection pool and closes it after the response. The password stays
`Redacted` in the app setting and in the client.

## Migrations

[`src/migrations.ts`](./src/migrations.ts) holds the schema as ordered
migrations (`0001_create_todos`, `0002_index_todos_created_at`). The
first request on an instance runs `MssqlMigrator.run`, which records each
applied migration in `effect_sql_migrations` and runs only the new ones.
Add a migration with the next number to change the schema; the next
request after the deploy applies it.

## Cost

A Basic database bills about $0.007 per hour (about $5 per month). The
logical server is free. The Flex Consumption app is billed per execution,
and its storage account costs under a cent. One test run takes about
5 minutes and costs a few cents, so the test is not gated.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-sql
pnpm deploy --profile <name>
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack. It reads the server, database, and firewall
rule through ARM (Azure Resource Manager) and checks their region, tier,
state, and IP range. It calls `/migrations` until the firewall rule is in
effect and checks that both migrations ran, then creates, lists, updates,
reads, and deletes a todo, and checks that an empty title answers `400`.
Then it destroys the stack and checks that the server and the function
app are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
