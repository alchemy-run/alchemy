import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { MigrationApplyError } from "../SQL/Migrations/Format.ts";
import {
  applySqlMigrations as applySnapshot,
  makeSyncSqlExecutor,
} from "../Workers/SqlMigrationsApply.ts";
import type { SqlMigrationSnapshot } from "../Workers/SqlMigrationsRuntime.ts";
import { DurableObjectState } from "./DurableObjectState.ts";

/** @internal */
export const applySqlMigrations: (
  migrations: SqlMigrationSnapshot,
) => Effect.Effect<
  void,
  MigrationApplyError,
  DurableObjectState | RuntimeContext
> = Effect.fn("Celld.SqlMigrations.apply")(function* (migrations) {
  const { raw } = yield* DurableObjectState;
  yield* applySnapshot(migrations, makeSyncSqlExecutor(raw.storage));
});
