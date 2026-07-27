/**
 * Barrel for the `alchemy/SQL` clients. Importing it eagerly loads every
 * backend — including `Postgres.ts`, which requires the optional
 * `@effect/sql-pg` peer dependency. If that peer isn't installed, import the
 * backend you need directly instead:
 *
 * ```typescript
 * import * as SQL from "alchemy/SQL/D1";
 *
 * const sql = yield* SQL.D1(d1);
 * ```
 */
export * from "./D1.ts";
export * from "./Postgres.ts";
export * from "./SqlFile.ts";
