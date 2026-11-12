# Starburst Galaxy governance

Row filtering, column masking and tagging on a Neon Postgres table, declared as resources.

- [`src/Crm.ts`](./src/Crm.ts) — a `Neon.Project` whose migration creates `crm.customers`, connected to Galaxy as a `PostgresqlCatalog`.
- [`src/Governance.ts`](./src/Governance.ts) — a `pii` `Tag` assigned to the email column, a `RowFilter` that keeps EU rows, a `ColumnMask` that hashes emails, and a `Policy` that grants the `EuAnalysts` role `SELECT` on the table through both.

## Commands

```sh
pnpm alchemy profile edit --add StarburstGalaxy   # once: the API client Alchemy deploys with
pnpm alchemy profile edit --add Neon              # once: the Neon API key
pnpm --filter starburst-galaxy-governance deploy
pnpm --filter starburst-galaxy-governance test
pnpm --filter starburst-galaxy-governance destroy
```
