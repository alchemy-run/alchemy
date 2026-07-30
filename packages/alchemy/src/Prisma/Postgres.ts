import { Database } from "./Database.ts";

/**
 * Product-shaped convenience alias for {@link Database}.
 *
 * `Prisma.Postgres(...)` and `Prisma.Database(...)` use the same underlying
 * Prisma Postgres resource provider. Prefer `Postgres` when you want the code
 * to read like the Prisma product name, and `Database` when you want to mirror
 * the Management API route names.
 *
 * @example
 * ```typescript
 * const project = yield* Prisma.Project("app", { createDatabase: false });
 * const postgres = yield* Prisma.Postgres("db", {
 *   project,
 *   name: "main",
 *   region: "us-east-1",
 * });
 * ```
 *
 * @resource
 */
export const Postgres = Database;
export type { DatabaseProps as PostgresProps } from "./Database.ts";
