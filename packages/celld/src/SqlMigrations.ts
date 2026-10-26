import type { SqlMigrationSnapshot } from "@alchemy.run/sql/Migrations/Embedded";
import {
  captureSqlMigrations,
  type SqlMigrationsInput,
} from "@alchemy.run/sql/Migrations/EmbeddedCapture";
import type { MigrationApplyError } from "@alchemy.run/sql/Migrations/Format";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { DurableObjectState } from "./DurableObjectState.ts";
import { applySqlMigrations } from "./SqlMigrationsApply.ts";
import { Worker } from "./Worker.ts";

export type { SqlMigrationsInput } from "@alchemy.run/sql/Migrations/EmbeddedCapture";
export type { SqlMigrationSnapshot } from "@alchemy.run/sql/Migrations/Embedded";

/** Captured SQL migrations with a runtime-only application method. */
export interface SqlMigrations extends SqlMigrationSnapshot {
  /** Apply pending files and their history rows in per-file native transactions. */
  readonly apply: () => Effect.Effect<
    void,
    MigrationApplyError,
    DurableObjectState | RuntimeContext
  >;
}

/**
 * Capture SQL files during construction and apply them to each Celld object.
 * Flat SQL files and modern drizzle-kit directories are supported. Paths are
 * relative to the directory where Alchemy runs. Records are embedded in the
 * bundle; object activation never reads migration files.
 *
 * ### Migrate on Activation
 * **Example:** Capture outside and apply inside the instance Effect
 * ```typescript
 * const migrations = yield* Celld.SqlMigrations("./migrations");
 * return Effect.gen(function* () {
 *   yield* migrations.apply().pipe(Effect.orDie);
 *   return {};
 * });
 * ```
 *
 * Existing compatible history is adopted without replaying applied files.
 * Each pending file and its history row commit together; a failed file does
 * not roll back successfully applied earlier files.
 *
 * @binding
 * @product Celld
 * @category Durable Objects
 */
export const SqlMigrations = Effect.fn("Celld.SqlMigrations")(function* (
  input: SqlMigrationsInput,
) {
  const snapshot = yield* captureSqlMigrations(input, Worker);
  return {
    ...snapshot,
    apply: () => applySqlMigrations(snapshot),
  } satisfies SqlMigrations;
});
