# Cloudflare Durable Object SQL

An Effect-native Worker with a separate SQLite users table for each named
Durable Object. Drizzle supplies typed queries; `Cloudflare.SqlMigrations`
loads checked-in SQL. No frontend, D1 database, `.sql` imports, or generated
`migrations.js` imports are needed.

## Run locally

Install the workspace dependencies from the repository root, then run all
example commands from this directory. Migration paths are relative to the
command's current working directory, not to `src/Users.ts`.

```sh
pnpm install
cd examples/cloudflare-durable-object-sql
pnpm dev
```

Use the local Worker URL printed by Alchemy:

```sh
URL='http://localhost:<port>'
curl -X POST "$URL/objects/team-a/users" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
curl "$URL/objects/team-a/users"
curl "$URL/objects/team-b/users"
```

POST returns `{ "user": { "id": 1, "name": "Ada" } }` on an empty object.
GET for `team-a` includes Ada; GET for `team-b` returns `{ "users": [] }`.
Object names accept letters, digits, `_`, and `-`.

## Deploy

Configure Cloudflare credentials with
`pnpm exec alchemy profile edit --add Cloudflare` (or use an existing
Alchemy profile / `CLOUDFLARE_API_TOKEN`), then:

```sh
pnpm deploy
```

Set `URL` to the deployed Worker URL and repeat the curl requests above.
The example uses local Alchemy state, so retain its `.alchemy` directory
for later deploys and cleanup.

```sh
pnpm destroy
```

Destroy removes the Worker and its Durable Object namespace, including
instance data. It does not remove the checked-in migration files.

## How migrations work

`src/Users.ts` reads `./drizzle` in the outer, construction-phase Effect:

```ts
const migrations = yield* Cloudflare.SqlMigrations("./drizzle");
```

The normalized migration records are embedded in the Worker JavaScript,
not in environment variables. Inside the instance Effect, Drizzle opens
the current object's database and applies pending migrations before
returning the client:

```ts
const db = yield* Drizzle.DurableObject({ migrations, relations });
```

This example checks in a small handwritten migration at
`drizzle/20260919000000_create_users/migration.sql` and matching Drizzle
tables in `src/schema.ts`. It needs no generation command to run. For a
schema change, add a new ordered migration directory and update the schema;
do not edit or rename a migration already applied. To generate SQL with
drizzle-kit in your own project, use a SQLite config and commit its
migration directories and snapshots before planning or deploying.
Restart `alchemy dev` after changing SQL files to capture the new records;
the SQL directory is not watched as part of the JavaScript import graph.

- Each instance records applied files in `__alchemy_migrations`. The
  object form, `Cloudflare.SqlMigrations({ dir: "./drizzle", table: "app_migrations" })`,
  selects another history table.
- Each pending file and its history row run in a native synchronous SQLite
  transaction. A failure rolls back that file and prevents activation;
  earlier successful files remain applied. The next activation retries the
  pending file.
- Deploying does not migrate every object in the namespace. Each object
  migrates when it activates with the new code.
- SQL must exist before construction/planning, including in CI.
  `SqlMigrations` does not generate migrations.
- An ORM is optional. In an object's inner Effect,
  `yield* migrations.apply().pipe(Effect.orDie)`
  applies the same records using the current Durable Object state.

The shared engine can adopt matching modern Drizzle history. This is
one-way: the old `__drizzle_migrations` table stays frozen, and Drizzle's
migrator must not run afterward. Keep every historical file. Application
errors use `MigrationError`; unmatched history uses
`MigrationHistoryConflictError`. Old `meta/_journal.json` directories are
rejected: upgrade with `drizzle-kit up`, review, and commit the result.

Existing `migrations.js` inputs to `Drizzle.DurableObject` remain supported
but still use Drizzle's migrator. Changing their `migrationsTable` to
`__alchemy_migrations` is not conversion; use `SqlMigrations` to opt into
the shared engine.

## Integration test

From this directory, with Cloudflare credentials configured:

```sh
pnpm test
```

The Bun test destroys any previous example deployment, deploys the Worker,
checks initial schema creation, POST/GET persistence, named-object
isolation, and input validation, then destroys the stack. It uses real
Cloudflare resources; it is not a local-dev test. Set `NO_DESTROY=1` to
retain the deployment after the test (the next test run still starts by
destroying it).
