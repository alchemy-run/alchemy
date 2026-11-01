import * as Effect from "effect/Effect";
import type { ConnectionPool } from "mssql";
import { MigrationError, type SqlExecutor } from "./Format.ts";
import { splitTsqlBatches } from "./Script.ts";
import { inlineSqlParams } from "./Utils.ts";

/**
 * Adapt an open `mssql` pool into the registry's {@link SqlExecutor}. Batches
 * run in a transaction, so a migration and its bookkeeping INSERT commit (or
 * roll back) together: T-SQL DDL is transactional. A statement SQL Server
 * refuses inside a transaction (`CREATE DATABASE`, `ALTER DATABASE`) fails the
 * migration.
 *
 * `GO` is not T-SQL but a separator client tools act on, and the server rejects
 * it. Each statement is split on it here and sent as separate T-SQL batches in
 * the same transaction, so a file can hold `CREATE PROCEDURE`, which has to
 * start its batch.
 *
 * The `mssql` import is type-only — how the pool is opened stays with the
 * database provider.
 */
export const makeMssqlMigrationExecutor = (pool: ConnectionPool): SqlExecutor => ({
  dialect: "mssql",
  query: (sql, params) =>
    Effect.tryPromise({
      try: () =>
        pool
          .request()
          .batch(inlineSqlParams(sql, params ?? [], "mssql"))
          .then((result) => (result.recordset ?? []) as Array<Record<string, unknown>>),
      catch: (cause) =>
        new MigrationError({
          message: `sql server query failed: ${String(cause)}`,
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.tryPromise({
      try: async () => {
        const transaction = pool.transaction();
        await transaction.begin();
        try {
          // Stop at the first error: by default a failed statement doesn't end
          // its T-SQL batch, so the ones after it would still run.
          await transaction.request().batch("SET XACT_ABORT ON");
          for (const statement of statements) {
            for (const batch of splitTsqlBatches(statement)) {
              await transaction.request().batch(batch);
            }
          }
          await transaction.commit();
        } catch (error) {
          // SQL Server has already rolled back an aborted transaction.
          await transaction.rollback().catch(() => {});
          throw error;
        }
      },
      catch: (cause) =>
        new MigrationError({
          message: `sql server migration batch failed: ${String(cause)}`,
          cause,
        }),
    }),
});
