/**
 * SQL migrations embedded into a Workers-style runtime bundle: captured
 * from a migrations directory during construction, carried into the
 * bundle as records, and applied to an object's native SQLite storage at
 * activation. Shared by every Durable Object host (Cloudflare today).
 * Runtime-safe: construction-time capture lives in `EmbeddedCapture.ts`.
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { applyPendingAlchemyFormat } from "./AlchemyFormat.ts";
import { MigrationError, type MigrationRecord, type SqlExecutor } from "./Format.ts";
import { inlineSqlParams } from "./Utils.ts";

/** SQL files captured during construction and embedded in the runtime bundle. */
export interface SqlMigrationSnapshot {
  /** Retained for compatibility with existing migration snapshots. */
  readonly _tag: "Cloudflare.SqlMigrations";
  /** The per-instance applied-migrations table. */
  readonly table: string;
  /** Ordered SQL records, including their content hashes. */
  readonly records: ReadonlyArray<MigrationRecord>;
}

/** @internal */
export interface SqlMigrationsExport {
  readonly kind: "sqlMigrations";
  readonly snapshot: SqlMigrationSnapshot;
}

/** @internal */
export const isSqlMigrationsExport = (value: unknown): value is SqlMigrationsExport =>
  typeof value === "object" && value !== null && "kind" in value && value.kind === "sqlMigrations";

export class SqlMigrationsRuntime extends Context.Service<
  SqlMigrationsRuntime,
  Readonly<Record<string, SqlMigrationSnapshot>>
>()("Cloudflare.SqlMigrationsRuntime") {}

/** Native synchronous SQLite storage (workerd's `ctx.storage`). */
export interface NativeSyncSqlStorage {
  readonly sql: {
    readonly exec: (sql: string) => { toArray(): Array<Record<string, unknown>> };
  };
  readonly transactionSync: <A>(run: () => A) => A;
}

/** A migration executor over native synchronous SQLite storage. */
export const makeSyncSqlExecutor = (storage: NativeSyncSqlStorage): SqlExecutor => ({
  dialect: "sqlite",
  query: (sql, params = []) =>
    Effect.try({
      try: () => storage.sql.exec(inlineSqlParams(sql, params, "sqlite")).toArray(),
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
});

/** Apply pending files, each with its history row in one native transaction. */
export const applySqlMigrationSnapshot = (
  migrations: SqlMigrationSnapshot,
  executor: SqlExecutor,
) =>
  applyPendingAlchemyFormat({
    executor,
    table: migrations.table,
    records: migrations.records,
  });
