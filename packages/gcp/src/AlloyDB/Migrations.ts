import {
  inlineSqlParams,
  MigrationError,
  runMigrations,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const toMigrationError =
  (context: string) =>
  <E extends { readonly _tag: string; readonly message?: string }>(cause: E) =>
    new MigrationError({
      message: `${context} failed: ${cause.message ?? cause._tag}`,
      cause,
    });

/** Each statement ends with exactly one `;` so they can share one call. */
const terminated = (statement: string) => {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
};

/** Rows of the last statement's result, keyed by column name. */
const rowsOf = (results: alloydb.SqlResultList | undefined) => {
  const result = results?.at(-1);
  const columns = (result?.columns ?? []).map((column) => column.name ?? "");
  return (result?.rows ?? []).map((row) =>
    Object.fromEntries(
      columns.map((name, index) => {
        const cell = row.values?.[index];
        return [name, cell?.nullValue ? null : (cell?.value ?? null)];
      }),
    ),
  );
};

/**
 * AlloyDB `instances.executeSql` as a {@link SqlExecutor}. Queries inline
 * their params (the Data API has no bind parameters). A batch is one call;
 * AlloyDB rolls back every statement of a call when one fails, so a
 * migration and its bookkeeping row commit together.
 */
const makeDataApiExecutor = Effect.fn(function* (options: {
  instance: string;
  database: string;
  user: string;
  password: string;
}) {
  const executeSql = yield* alloydb.executeSqlProjectsLocationsClustersInstances;
  const run = (sqlStatement: string) =>
    executeSql({
      instance: options.instance,
      body: {
        database: options.database,
        user: options.user,
        password: options.password,
        sqlStatement,
      },
    }).pipe(
      Effect.mapError(toMigrationError(`executeSql on '${options.instance}'`)),
      // SQL errors come back inside a 200 response.
      Effect.flatMap((response) =>
        response.metadata?.status === "ERROR"
          ? Effect.fail(
              new MigrationError({
                message: `executeSql on '${options.instance}' failed: ${response.metadata.message ?? "unknown error"}`,
              }),
            )
          : Effect.succeed(response.sqlResults),
      ),
    );
  return {
    dialect: "postgres",
    query: (sql, params) =>
      run(inlineSqlParams(sql, params ?? [], "postgres")).pipe(Effect.map(rowsOf)),
    batch: (statements) => run(statements.map(terminated).join("\n")).pipe(Effect.asVoid),
  } satisfies SqlExecutor;
});

// A just-created instance or user can take a few seconds to accept logins.
const loginRetry = { schedule: Schedule.spaced("5 seconds"), times: 6 };

/**
 * Apply migrations to a database on an AlloyDB primary instance through
 * the Data API. Call once the instance is ready.
 */
export const runInstanceMigrations = Effect.fn(function* (options: {
  instance: string;
  database: string;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
  user: string | undefined;
  password: string | Redacted.Redacted<string> | undefined;
}) {
  if (options.user === undefined || options.password === undefined) {
    return yield* new MigrationError({
      message: `Migrations on '${options.instance}' need credentials; set migrationsUser and migrationsPassword`,
    });
  }
  const executor: SqlExecutor = yield* makeDataApiExecutor({
    instance: options.instance,
    database: options.database,
    user: options.user,
    password: Redacted.isRedacted(options.password)
      ? Redacted.value(options.password)
      : options.password,
  });
  return yield* runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      // Probe once so a fresh login's delay is retried before any
      // migration runs; batches themselves are never retried.
      executor
        .query("SELECT 1 AS ok")
        .pipe(Effect.retry(loginRetry), Effect.andThen(apply(executor))),
  });
});
