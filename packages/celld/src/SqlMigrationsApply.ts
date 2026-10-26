import {
  applySqlMigrationSnapshot,
  makeSyncSqlExecutor,
  type SqlMigrationSnapshot,
} from "@alchemy.run/sql/Migrations/Embedded";
import type { MigrationApplyError } from "@alchemy.run/sql/Migrations/Format";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { DurableObjectState } from "./DurableObjectState.ts";

/** @internal */
export const applySqlMigrations: (
  migrations: SqlMigrationSnapshot,
) => Effect.Effect<void, MigrationApplyError, DurableObjectState | RuntimeContext> = Effect.fn(
  "Celld.SqlMigrations.apply",
)(function* (migrations) {
  const { raw } = yield* DurableObjectState;
  yield* applySqlMigrationSnapshot(migrations, makeSyncSqlExecutor(raw.storage as any));
});
