import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { applyAlchemyFormat } from "../../SQL/Migrations/AlchemyFormat.ts";
import {
  MigrationError,
  type MigrationHistoryConflictError,
  type SqlExecutor,
} from "../../SQL/Migrations/Format.ts";
import { inlineSqlParams } from "../../SQL/Migrations/Utils.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { SqlMigrationSnapshot } from "./SqlMigrationsRuntime.ts";

/**
 * Apply captured SQL migrations to the current Durable Object's SQLite storage.
 * Each migration and its bookkeeping row commit atomically through the native
 * `storage.transactionSync` API. Already-applied files are skipped. Existing
 * modern Drizzle history is adopted into Alchemy's table without replaying it.
 *
 * Run this in the inner instance Effect, before returning public methods.
 * It migrates only the activating object, not every object during deployment.
 * `Drizzle.DurableObject({ migrations })` calls this automatically for snapshots
 * returned by {@link SqlMigrations}.
 *
 * ### Migrations Without an ORM
 * **Example:** Apply SQL before exposing the object's methods
 * ```typescript
 * export class Users extends Cloudflare.DurableObject<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     const migrations = yield* Cloudflare.SqlMigrations("./migrations");
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.gen(function* () {
 *       yield* Cloudflare.applySqlMigrations(migrations).pipe(Effect.orDie);
 *       return {
 *         count: () => state.storage.sql.exec<{ count: number }>(
 *           "SELECT count(*) AS count FROM users",
 *         ).pipe(
 *           Effect.flatMap((cursor) => cursor.one()),
 *           Effect.map((row) => row.count),
 *         ),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const applySqlMigrations: (
  migrations: SqlMigrationSnapshot,
) => Effect.Effect<
  void,
  MigrationError | MigrationHistoryConflictError,
  DurableObjectState | RuntimeContext
> = Effect.fn("Cloudflare.applySqlMigrations")(function* (migrations) {
  const { raw } = yield* DurableObjectState;
  const storage = raw.storage;
  const executor: SqlExecutor = {
    dialect: "sqlite",
    query: (sql, params = []) =>
      Effect.try({
        try: () =>
          storage.sql.exec(inlineSqlParams(sql, params, "sqlite")).toArray(),
        catch: (cause) =>
          new MigrationError({
            message: "Failed to query migration history",
            cause,
          }),
      }),
    batch: (statements) =>
      Effect.try({
        try: () =>
          storage.transactionSync(() => {
            for (const statement of statements) storage.sql.exec(statement);
          }),
        catch: (cause) =>
          new MigrationError({
            message: "Failed to apply SQL migration",
            cause,
          }),
      }),
  };
  yield* applyAlchemyFormat({
    executor,
    table: migrations.table,
    records: migrations.records,
  });
});
