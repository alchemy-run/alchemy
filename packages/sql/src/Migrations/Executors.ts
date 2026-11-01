import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ConnectionPool, config as MssqlConfig } from "mssql";
import type { Connection, ConnectionOptions } from "mysql2/promise";
import type { Client, ClientConfig } from "pg";
import { importMssql } from "../MssqlDriver.ts";
import { importMySql } from "../MySQLDriver.ts";
import { importPg } from "../PostgresDriver.ts";
import { MigrationError, type MigrationDialect, type SqlExecutor } from "./Format.ts";
import { makeMssqlMigrationExecutor } from "./MssqlExecutor.ts";
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
 * Open a `pg` client for the scope of `use`; it always closes afterwards,
 * including when `connect` itself fails. `config` goes to
 * `new Client(config)` unchanged — a connection string, TLS options, or a
 * `stream` the provider already connected (the Cloud SQL connector).
 * Prefer {@link withPgExecutor}; use this when the provider runs its own
 * executor over the client (DSQL) or plain SQL (`importFiles`).
 */
export interface ConnectOptions {
  /**
   * Retry the connect — never `use` — while this holds for the driver's
   * error, e.g. DNS that hasn't propagated for a just-created host.
   */
  readonly retryConnect?: {
    readonly while: (cause: unknown) => boolean;
    readonly times: number;
    readonly interval: Duration.Input;
  };
  /** Rewrite a connect failure that survived the retry, e.g. to add a hint. */
  readonly onConnectFailure?: (error: MigrationError) => MigrationError;
}

const retryingConnect = <A>(
  connect: Effect.Effect<A, MigrationError>,
  options: ConnectOptions | undefined,
): Effect.Effect<A, MigrationError> => {
  const retry = options?.retryConnect;
  const retried = retry
    ? connect.pipe(
        Effect.retry({
          while: (error) => retry.while(error.cause),
          schedule: Schedule.spaced(retry.interval),
          times: retry.times,
        }),
      )
    : connect;
  const rewrite = options?.onConnectFailure;
  return rewrite ? retried.pipe(Effect.mapError(rewrite)) : retried;
};

export const withPgClient = <A, E, R>(
  config: ClientConfig,
  use: (client: Client) => Effect.Effect<A, E, R>,
  options?: ConnectOptions,
): Effect.Effect<A, MigrationError | E, R> =>
  Effect.acquireUseRelease(
    retryingConnect(
      Effect.tryPromise({
        try: async () => {
          const { Client } = await importPg();
          const client = new Client(config);
          // pg reports idle socket failures as events; the next query fails
          // through the error channel instead of crashing the process.
          client.on("error", () => {});
          try {
            await client.connect();
          } catch (error) {
            await client.end().catch(() => {});
            throw error;
          }
          return client;
        },
        catch: migrationError(`Connecting to postgres${config.host ? ` at ${config.host}` : ""}`),
      }),
      options,
    ),
    use,
    (client) => Effect.promise(() => client.end().catch(() => {})),
  );

/** {@link withPgClient} handing over the client as a {@link SqlExecutor}. */
export const withPgExecutor = <A, E, R>(
  config: ClientConfig,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
  options?: ConnectOptions,
): Effect.Effect<A, MigrationError | E, R> =>
  withPgClient(config, (client) => use(makePgMigrationExecutor(client)), options);

/**
 * Open a `mysql2` connection for the scope of `use`; it always closes
 * afterwards. `config` goes to `createConnection(config)` unchanged.
 * Prefer {@link withMySqlExecutor}.
 */
export const withMySqlConnection = <A, E, R>(
  config: ConnectionOptions,
  use: (connection: Connection) => Effect.Effect<A, E, R>,
  options?: ConnectOptions,
): Effect.Effect<A, MigrationError | E, R> =>
  Effect.acquireUseRelease(
    retryingConnect(
      Effect.tryPromise({
        try: async () => {
          const { createConnection } = await importMySql();
          return createConnection(config);
        },
        catch: migrationError(`Connecting to mysql${config.host ? ` at ${config.host}` : ""}`),
      }),
      options,
    ),
    use,
    (connection) => Effect.promise(() => connection.end().catch(() => {})),
  );

/** {@link withMySqlConnection} handing over the connection as a {@link SqlExecutor}. */
export const withMySqlExecutor = <A, E, R>(
  config: ConnectionOptions,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
  options?: ConnectOptions,
): Effect.Effect<A, MigrationError | E, R> =>
  withMySqlConnection(config, (connection) => use(makeMySQLMigrationExecutor(connection)), options);

/**
 * Open an `mssql` connection pool for the scope of `use`; it always closes
 * afterwards, including when connecting fails. `config` goes to
 * `new ConnectionPool(config)` unchanged. Prefer {@link withMssqlExecutor}.
 */
export const withMssqlPool = <A, E, R>(
  config: MssqlConfig,
  use: (pool: ConnectionPool) => Effect.Effect<A, E, R>,
  options?: ConnectOptions,
): Effect.Effect<A, MigrationError | E, R> =>
  Effect.acquireUseRelease(
    retryingConnect(
      Effect.tryPromise({
        try: async () => {
          const { ConnectionPool } = await importMssql();
          const pool = new ConnectionPool(config);
          // The pool reports idle socket failures as events; the next query
          // fails through the error channel instead of crashing the process.
          pool.on("error", () => {});
          try {
            await pool.connect();
          } catch (error) {
            await pool.close().catch(() => {});
            throw error;
          }
          return pool;
        },
        catch: migrationError(`Connecting to sql server at ${config.server}`),
      }),
      options,
    ),
    use,
    (pool) => Effect.promise(() => pool.close().catch(() => {})),
  );

/** {@link withMssqlPool} handing over the pool as a {@link SqlExecutor}. */
export const withMssqlExecutor = <A, E, R>(
  config: MssqlConfig,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
  options?: ConnectOptions,
): Effect.Effect<A, MigrationError | E, R> =>
  withMssqlPool(config, (pool) => use(makeMssqlMigrationExecutor(pool)), options);

export type Rows = Array<Record<string, unknown>>;

const BEGIN_TRANSACTION: Partial<Record<MigrationDialect, string>> = {
  mysql: "START TRANSACTION;",
  mssql: "BEGIN TRANSACTION;",
};

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
 *   (`START TRANSACTION` on MySQL, `BEGIN TRANSACTION` on SQL Server).
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
          ? [BEGIN_TRANSACTION[options.dialect] ?? "BEGIN;", ...body, "COMMIT;"]
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
