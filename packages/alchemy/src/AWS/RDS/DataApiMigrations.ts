import * as rds from "@distilled.cloud/aws/rds";
import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  inlineSqlParams,
  MigrationError,
  runMigrations,
  type MigrationDialect,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "../../SQL/Migrations/index.ts";

// An auto-paused Serverless v2 writer resumes on the first request.
const resumeRetry = {
  while: (e: { readonly _tag: string }) => e._tag === "DatabaseResumingException",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
};

const toMigrationError =
  (context: string) =>
  <E extends { readonly _tag: string; readonly message?: string }>(cause: E) =>
    new MigrationError({
      message: `Data API ${context} failed: ${cause.message ?? cause._tag}`,
      cause,
    });

/**
 * Adapt the Data API into the registry's {@link SqlExecutor}. Queries
 * inline their params (the Data API binds `:name` placeholders only), and
 * batches run inside a Data API transaction.
 */
const makeDataApiMigrationExecutor = Effect.fn(function* (target: {
  dialect: MigrationDialect;
  resourceArn: string;
  secretArn: string;
  database: string | undefined;
}) {
  const executeStatement = yield* rdsdata.executeStatement;
  const beginTransaction = yield* rdsdata.beginTransaction;
  const commitTransaction = yield* rdsdata.commitTransaction;
  const rollbackTransaction = yield* rdsdata.rollbackTransaction;
  const { dialect, resourceArn, secretArn, database } = target;

  return {
    dialect,
    query: (sql, params) =>
      executeStatement({
        resourceArn,
        secretArn,
        database,
        sql: inlineSqlParams(sql, params ?? [], dialect),
        formatRecordsAs: "JSON",
      }).pipe(
        Effect.retry(resumeRetry),
        Effect.mapError(toMigrationError("query")),
        Effect.flatMap((result) =>
          Effect.try({
            try: () =>
              (result.formattedRecords ? JSON.parse(result.formattedRecords) : []) as Array<
                Record<string, unknown>
              >,
            catch: (cause) =>
              new MigrationError({
                message: `Data API returned malformed records: ${String(cause)}`,
                cause,
              }),
          }),
        ),
      ),
    batch: (statements) =>
      Effect.gen(function* () {
        const { transactionId } = yield* beginTransaction({
          resourceArn,
          secretArn,
          database,
        }).pipe(Effect.retry(resumeRetry), Effect.mapError(toMigrationError("begin transaction")));
        if (!transactionId) {
          return yield* new MigrationError({ message: "Data API returned no transaction id" });
        }
        yield* Effect.gen(function* () {
          yield* Effect.forEach(
            statements,
            (sql) => executeStatement({ resourceArn, secretArn, database, sql, transactionId }),
            { discard: true },
          );
          yield* commitTransaction({ resourceArn, secretArn, transactionId });
        }).pipe(
          Effect.onError(() =>
            rollbackTransaction({ resourceArn, secretArn, transactionId }).pipe(Effect.ignore),
          ),
          Effect.mapError(toMigrationError("migration batch")),
        );
      }),
  } satisfies SqlExecutor;
});

/**
 * Apply migrations to an Aurora cluster's database over the RDS Data API.
 * The cluster supplies the ARN, engine, default database, and default
 * secret; the caller must run this once a writer instance is available.
 */
export const runDataApiMigrations = Effect.fn(function* (options: {
  dbClusterIdentifier: string;
  secretArn: string | undefined;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) {
  const { dbClusterIdentifier } = options;
  const cluster = yield* rds.describeDBClusters({ DBClusterIdentifier: dbClusterIdentifier }).pipe(
    Effect.map((response) => response.DBClusters?.[0]),
    Effect.catchTag("DBClusterNotFoundFault", () => Effect.succeed(undefined)),
  );
  if (!cluster?.DBClusterArn) {
    return yield* new MigrationError({
      message: `DB cluster '${dbClusterIdentifier}' not found`,
    });
  }
  if (!cluster.HttpEndpointEnabled) {
    return yield* new MigrationError({
      message: `DB cluster '${dbClusterIdentifier}' does not have the Data API enabled (set enableHttpEndpoint: true)`,
    });
  }
  const secretArn = options.secretArn ?? cluster.MasterUserSecret?.SecretArn;
  if (!secretArn) {
    return yield* new MigrationError({
      message: `DB cluster '${dbClusterIdentifier}' has no RDS-managed master secret; pass migrationsSecretArn`,
    });
  }
  const resourceArn = cluster.DBClusterArn;
  return yield* runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      makeDataApiMigrationExecutor({
        dialect: cluster.Engine?.includes("mysql") ? "mysql" : "postgres",
        resourceArn,
        secretArn,
        database: cluster.DatabaseName,
      }).pipe(Effect.flatMap(apply)),
  });
});
