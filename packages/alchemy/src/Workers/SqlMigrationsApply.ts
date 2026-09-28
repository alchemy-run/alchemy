import * as Effect from "effect/Effect";
import { applyAlchemyFormat } from "../SQL/Migrations/AlchemyFormat.ts";
import { MigrationError, type SqlExecutor } from "../SQL/Migrations/Format.ts";
import { inlineSqlParams } from "../SQL/Migrations/Utils.ts";
import type { SqlMigrationSnapshot } from "./SqlMigrationsRuntime.ts";

/** Apply one file and its history row in each native executor batch. */
export const applySqlMigrations = (
  migrations: SqlMigrationSnapshot,
  executor: SqlExecutor,
) =>
  applyAlchemyFormat({
    executor,
    table: migrations.table,
    records: migrations.records,
  });

/** Native synchronous SQLite storage used by Cloudflare and Celld. */
export interface NativeSyncSqlStorage {
  readonly sql: {
    readonly exec: (sql: string) => {
      toArray(): Array<Record<string, unknown>>;
    };
  };
  readonly transactionSync: <A>(run: () => A) => A;
}

export const makeSyncSqlExecutor = (
  storage: NativeSyncSqlStorage,
): SqlExecutor => ({
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
        new MigrationError({ message: "Failed to apply SQL migration", cause }),
    }),
});

/** Query bound to a native connection or a leased SQLite transaction. */
export type NativeSqlQuery = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

/** An asynchronous SQLite backend whose callback owns one real transaction. */
export interface NativeAsyncSqlStorage {
  readonly query: NativeSqlQuery;
  readonly transaction: (
    run: (query: NativeSqlQuery) => Promise<void>,
  ) => Promise<void>;
}

/** Adapt native transaction leases without sharing connections across batches. */
export const makeAsyncSqlExecutor = (
  storage: NativeAsyncSqlStorage,
): SqlExecutor => ({
  dialect: "sqlite",
  query: (sql, params = []) =>
    Effect.tryPromise({
      try: () => storage.query(inlineSqlParams(sql, params, "sqlite")),
      catch: (cause) =>
        new MigrationError({
          message: "Failed to query migration history",
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction((query) =>
          Effect.forEach(
            statements,
            (statement) => Effect.tryPromise(() => query(statement)),
            {
              concurrency: 1,
              discard: true,
            },
          ).pipe(Effect.runPromise),
        ),
      catch: (cause) =>
        new MigrationError({ message: "Failed to apply SQL migration", cause }),
    }),
});
