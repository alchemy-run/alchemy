import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ConnectionOptions } from "mysql2/promise";
import type { ClientConfig } from "pg";
import { importMySql } from "../MySQLDriver.ts";
import { importPg } from "../PostgresDriver.ts";
import { MigrationError, type MigrationDialect, type SqlExecutor } from "./Format.ts";
import { makeMySQLMigrationExecutor } from "./MySQLExecutor.ts";
import { makePgMigrationExecutor } from "./PgExecutor.ts";
import { inlineSqlParams } from "./Utils.ts";

const describeCause = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const { message, _tag } = cause as { message?: unknown; _tag?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
    if (typeof _tag === "string") return _tag;
  }
  return String(cause);
};

/**
 * Wrap any failure from a migration transport as a {@link MigrationError}
 * that names what failed: `Effect.mapError(migrationError("executeSql on app"))`.
 */
export const migrationError =
  (context: string) =>
  (cause: unknown): MigrationError =>
    new MigrationError({ message: `${context} failed: ${describeCause(cause)}`, cause });

/**
 * Open a `pg` client for the scope of `use` and hand it over as a
 * {@link SqlExecutor}; the client always closes afterwards. `config` goes to
 * `new Client(config)` unchanged — a connection string, TLS options, or a
 * `stream` the provider already connected (the Cloud SQL connector).
 */
export const withPgExecutor = <A, E, R>(
  config: ClientConfig,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
): Effect.Effect<A, MigrationError | E, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const { Client } = await importPg();
        const client = new Client(config);
        await client.connect();
        return client;
      },
      catch: migrationError(`Connecting to postgres${config.host ? ` at ${config.host}` : ""}`),
    }),
    (client) => use(makePgMigrationExecutor(client)),
    (client) => Effect.promise(() => client.end().catch(() => {})),
  );

/**
 * Open a `mysql2` connection for the scope of `use` and hand it over as a
 * {@link SqlExecutor}; the connection always closes afterwards. `config` goes
 * to `createConnection(config)` unchanged.
 */
export const withMySqlExecutor = <A, E, R>(
  config: ConnectionOptions,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
): Effect.Effect<A, MigrationError | E, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const { createConnection } = await importMySql();
        return createConnection(config);
      },
      catch: migrationError(`Connecting to mysql${config.host ? ` at ${config.host}` : ""}`),
    }),
    (connection) => use(makeMySQLMigrationExecutor(connection)),
    (connection) => Effect.promise(() => connection.end().catch(() => {})),
  );

export type Rows = Array<Record<string, unknown>>;

/** Each statement ends with exactly one `;`, so several share one request. */
const terminated = (statement: string) => {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
};

/**
 * A {@link SqlExecutor} over an API that runs a SQL string and returns rows —
 * the Cloud SQL and AlloyDB Data APIs, or any HTTP SQL endpoint. The provider
 * supplies only `execute`, which must fail when the database reports an
 * error (Data APIs return SQL errors inside a 200). Params are inlined, since
 * these APIs bind none.
 *
 * `batch` sets how a migration and its bookkeeping row commit together:
 * - `"transaction"` — one request wrapped in `BEGIN`/`COMMIT`
 *   (`START TRANSACTION` on MySQL).
 * - `"atomic"` — one request the API already commits as a unit.
 */
export const makeStatementExecutor = (options: {
  dialect: MigrationDialect;
  execute: (sql: string) => Effect.Effect<Rows, MigrationError>;
  batch: "transaction" | "atomic";
}): SqlExecutor => ({
  dialect: options.dialect,
  query: (sql, params) => options.execute(inlineSqlParams(sql, params ?? [], options.dialect)),
  batch: (statements) => {
    const body = statements.map(terminated);
    return options
      .execute(
        (options.batch === "transaction"
          ? [options.dialect === "mysql" ? "START TRANSACTION;" : "BEGIN;", ...body, "COMMIT;"]
          : body
        ).join("\n"),
      )
      .pipe(Effect.asVoid);
  },
});

/**
 * Rows keyed by column name from the `columns` + `rows[].values[]` shape the
 * GCP Data APIs return; `nullValue` cells become `null`.
 */
export const rowsFromCells = (
  columns: ReadonlyArray<{ readonly name?: string }> | undefined,
  rows:
    | ReadonlyArray<{
        readonly values?: ReadonlyArray<{ readonly value?: string; readonly nullValue?: boolean }>;
      }>
    | undefined,
): Rows => {
  const names = (columns ?? []).map((column) => column.name ?? "");
  return (rows ?? []).map((row) =>
    Object.fromEntries(
      names.map((name, index) => {
        const cell = row.values?.[index];
        return [name, cell?.nullValue ? null : (cell?.value ?? null)];
      }),
    ),
  );
};

/**
 * Retry `effect` while a just-created user or database starts accepting
 * logins, which can take seconds. Wrap only idempotent work — a probe
 * query or a connection that runs one — never a migration batch.
 */
export const retryLogin = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { attempts?: number; interval?: Duration.Input },
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.spaced(options?.interval ?? "5 seconds"),
      times: options?.attempts ?? 6,
    }),
  );

/**
 * Run `SELECT 1` under {@link retryLogin}, then return the executor, so a
 * login delay is retried before any migration batch runs.
 */
export const probeExecutor = (executor: SqlExecutor): Effect.Effect<SqlExecutor, MigrationError> =>
  retryLogin(executor.query("SELECT 1")).pipe(Effect.as(executor));
