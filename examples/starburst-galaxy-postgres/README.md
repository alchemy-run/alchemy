# Starburst Galaxy over Postgres

A Neon Postgres database queried through Starburst Galaxy, with a read-only reporting login.

- [`src/Warehouse.ts`](./src/Warehouse.ts) — a `Neon.Project` whose migration creates `shop.orders`, connected to Galaxy as a `PostgresqlCatalog`. Galaxy checks the connection on every deploy.
- [`src/Reporting.ts`](./src/Reporting.ts) — a free `Cluster` over the catalog that suspends after a minute, a `Reporting` role that may use the cluster and read the `shop` schema, and a `ServiceAccount` with that role and a Trino password.

Log in to the stack's `trinoUri` as its `userName` with the password's `trinoPassword`, from the Trino CLI, JDBC, or any Trino client:

```sh
trino --server "$TRINO_URI" --user "$USER_NAME" --password \
  --execute 'SELECT customer, amount FROM "<catalog>".shop.orders'
```

## Commands

```sh
pnpm alchemy profile edit --add StarburstGalaxy   # once: the API client Alchemy deploys with
pnpm alchemy profile edit --add Neon              # once: the Neon API key
pnpm --filter starburst-galaxy-postgres deploy
pnpm --filter starburst-galaxy-postgres test
pnpm --filter starburst-galaxy-postgres destroy
```
