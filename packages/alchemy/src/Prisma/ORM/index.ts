// Prisma ORM v8 integration: contract emission + migration
// planning (`Contract`), deploy-time application (`Migrate`), and the
// per-execution Postgres runtime client (subpath-only, see below).
//
// `Postgres.ts` is deliberately NOT re-exported: its `@prisma/orm-postgres`
// peer is optional, and keeping it out of the barrel keeps the peer out of
// every non-user's module graph. Import it as `alchemy/Prisma/ORM/Postgres`.
export * from "./Contract.ts";
export * from "./Errors.ts";
export * from "./Migrate.ts";
export { CliError } from "./internal.ts";
