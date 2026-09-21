import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type {
  MigrationError,
  MigrationHistoryConflictError,
} from "../SQL/Migrations/Format.ts";
import {
  captureSqlMigrations,
  type SqlMigrationsInput,
} from "../Workers/SqlMigrations.ts";
import {
  applySqlMigrations,
  makeAsyncSqlExecutor,
} from "../Workers/SqlMigrationsApply.ts";
import type { SqlMigrationSnapshot } from "../Workers/SqlMigrationsRuntime.ts";
import { NativeContext } from "./DurableObjectState.ts";
import { Worker } from "./Worker.ts";

export type { SqlMigrationsInput, SqlMigrationSnapshot };

/** Apply embedded records through one isolated SQL lease per file. @internal */
export const applyRivetSqlMigrations = (snapshot: SqlMigrationSnapshot) =>
  Effect.gen(function* () {
    const native = yield* NativeContext;
    return yield* applySqlMigrations(
      snapshot,
      makeAsyncSqlExecutor({
        query: (sql) => native.db.execute(sql),
        transaction: (run) =>
          native.db.transaction((lease) => run((sql) => lease.execute(sql))),
      }),
    );
  });

/** Captured migration records applied through an isolated native SQL lease. */
export interface SqlMigrations extends SqlMigrationSnapshot {
  /** Apply each pending file and history row atomically; actor KV and schedules are separate. */
  readonly apply: () => Effect.Effect<
    void,
    MigrationError | MigrationHistoryConflictError,
    RuntimeContext
  >;
}

/**
 * Capture SQL files at construction and apply them on real actor activation.
 * Each file and its history row use one native db.transaction lease. Earlier
 * successful files remain committed when a later file fails. Actor-state KV
 * and scheduled actions do not participate in the SQL transaction.
 *
 * ### Migrate on Activation
 * **Example:** Capture once, apply before exposing methods
 * ```typescript
 * const migrations = yield* Rivet.SqlMigrations("./migrations");
 * const state = yield* Rivet.DurableObjectState;
 * return Effect.gen(function* () {
 *   yield* migrations.apply().pipe(Effect.orDie);
 *   return { list: () => state.storage.sql.exec("SELECT * FROM users") };
 * });
 * ```
 *
 * @binding
 * @product Rivet
 */
export const SqlMigrations = Effect.fn("Rivet.SqlMigrations")(function* (
  input: SqlMigrationsInput,
) {
  const host = yield* Worker;
  const snapshot = yield* captureSqlMigrations(input, host);
  return {
    ...snapshot,
    apply: () => applyRivetSqlMigrations(snapshot),
  } satisfies SqlMigrations;
});
