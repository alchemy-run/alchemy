import * as rds from "@distilled.cloud/aws/rds";
import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  diffMigrations,
  inlineSqlParams,
  MigrationError,
  migrationsAttrs,
  normalizeMigrationsInput,
  runMigrations,
  stampedOf,
  type MigrationDialect,
  type MigrationsInput,
  type SqlExecutor,
} from "../../SQL/Migrations/index.ts";
import type { Providers } from "../Providers.ts";

export interface DBClusterMigrationsProps {
  /**
   * Identifier of the Aurora cluster to migrate. The cluster must have the
   * Data API enabled (`enableHttpEndpoint: true`) and an available writer
   * instance, so pass the writer `DBInstance`'s `dbClusterIdentifier` to
   * order the migrations after it. Changing it replaces the resource.
   */
  dbClusterIdentifier: string;
  /**
   * ARN of the Secrets Manager secret (JSON with `username` and `password`)
   * the Data API authenticates with.
   * @default the cluster's RDS-managed master user secret
   */
  secretArn?: string;
  /**
   * Database to migrate. Changing it replaces the resource.
   * @default the cluster's `databaseName`
   */
  database?: string;
  /**
   * SQL migrations to apply on deploy. Accepts a directory path, a
   * `Drizzle.Schema` resource, or `{ dir, table? }`.
   *
   * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table. A
   * database previously migrated by drizzle-kit or Prisma is adopted by a
   * one-way conversion on first deploy: the old tool's applied history is
   * copied into Alchemy's table and the old table is left frozen.
   *
   * The Data API runs one statement per call: put each statement in its own
   * file or separate statements with `--> statement-breakpoint`
   * (drizzle-kit's default).
   */
  migrations: MigrationsInput;
}

export interface DBClusterMigrations extends Resource<
  "AWS.RDS.DBClusterMigrations",
  DBClusterMigrationsProps,
  {
    /** ARN of the migrated cluster. */
    dbClusterArn: string;
    /** Database the migrations were applied to. */
    database: string | undefined;
    /** Directory of the applied SQL migrations. */
    migrationsDir: string | undefined;
    /** Migration bookkeeping table. */
    migrationsTable: string | undefined;
    /** Applied migration content hashes. */
    migrationsHashes: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Applies SQL migrations to an Aurora cluster over the RDS Data API — no
 * VPC access or database socket is needed from the deploying machine.
 *
 * Each migration and its bookkeeping row run in one Data API transaction.
 * Destroying the resource never touches the database.
 *
 * `AWS.RDS.Aurora` creates this resource for you when given `migrations`.
 * ### Migrating a Cluster
 * **Example:** Migrate after the writer is available
 * ```typescript
 * const cluster = yield* AWS.RDS.DBCluster("Cluster", {
 *   engine: "aurora-postgresql",
 *   databaseName: "app",
 *   enableHttpEndpoint: true,
 *   manageMasterUserPassword: true,
 *   masterUsername: "app",
 * });
 * const writer = yield* AWS.RDS.DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.serverless",
 *   engine: "aurora-postgresql",
 * });
 * yield* AWS.RDS.DBClusterMigrations("Migrations", {
 *   dbClusterIdentifier: writer.dbClusterIdentifier.as<string>(),
 *   migrations: "./migrations",
 * });
 * ```
 *
 * @resource
 */
export const DBClusterMigrations = Resource<DBClusterMigrations>("AWS.RDS.DBClusterMigrations");

export class DBClusterMigrationsError extends Data.TaggedError("DBClusterMigrationsError")<{
  message: string;
}> {}

const dialectOf = (engine: string | undefined): MigrationDialect =>
  engine?.includes("mysql") ? "mysql" : "postgres";

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
  // An auto-paused Serverless v2 writer resumes on the first request.
  const retryResuming = {
    while: (error: { _tag: string }) => error._tag === "DatabaseResumingException",
    schedule: Schedule.spaced("5 seconds"),
    times: 10,
  };
  const toMigrationError = (context: string) => (cause: { _tag: string; message?: string }) =>
    new MigrationError({
      message: `Data API ${context} failed: ${cause.message ?? cause._tag}`,
      cause,
    });

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
        Effect.retry(retryResuming),
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
        }).pipe(Effect.retry(retryResuming));
        if (!transactionId) {
          return yield* new MigrationError({ message: "Data API returned no transaction id" });
        }
        yield* Effect.forEach(
          statements,
          (sql) => executeStatement({ resourceArn, secretArn, database, sql, transactionId }),
          { discard: true },
        ).pipe(
          Effect.tapError(() =>
            rollbackTransaction({ resourceArn, secretArn, transactionId }).pipe(Effect.ignore),
          ),
        );
        yield* commitTransaction({ resourceArn, secretArn, transactionId });
      }).pipe(Effect.mapError(toMigrationError("migration batch"))),
  } satisfies SqlExecutor;
});

export const DBClusterMigrationsProvider = () =>
  Provider.succeed(DBClusterMigrations, {
    // Non-listable: the bookkeeping lives inside the cluster's database.
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (
        olds !== undefined &&
        (olds.dbClusterIdentifier !== news.dbClusterIdentifier || olds.database !== news.database)
      ) {
        return { action: "replace" } as const;
      }
      if (yield* diffMigrations({ news, output })) {
        return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      // Observe — the cluster supplies the ARN, engine, default database,
      // and default secret the Data API needs.
      const cluster = yield* rds
        .describeDBClusters({ DBClusterIdentifier: news.dbClusterIdentifier })
        .pipe(
          Effect.map((response) => response.DBClusters?.[0]),
          Effect.catchTag("DBClusterNotFoundFault", () => Effect.succeed(undefined)),
        );
      if (!cluster?.DBClusterArn) {
        return yield* new DBClusterMigrationsError({
          message: `DB cluster '${news.dbClusterIdentifier}' not found`,
        });
      }
      if (!cluster.HttpEndpointEnabled) {
        return yield* new DBClusterMigrationsError({
          message: `DB cluster '${news.dbClusterIdentifier}' does not have the Data API enabled (set enableHttpEndpoint: true)`,
        });
      }
      if (!cluster.DBClusterMembers?.some((member) => member.IsClusterWriter)) {
        return yield* new DBClusterMigrationsError({
          message: `DB cluster '${news.dbClusterIdentifier}' has no writer instance; pass the writer DBInstance's dbClusterIdentifier so migrations run after it`,
        });
      }
      const secretArn = news.secretArn ?? cluster.MasterUserSecret?.SecretArn;
      if (!secretArn) {
        return yield* new DBClusterMigrationsError({
          message: `DB cluster '${news.dbClusterIdentifier}' has no RDS-managed master secret; pass secretArn`,
        });
      }
      const dbClusterArn = cluster.DBClusterArn;
      const database = news.database ?? cluster.DatabaseName;
      const previous =
        output?.dbClusterArn === dbClusterArn && output.database === database ? output : undefined;

      // Sync — the shared pipeline skips already-applied migrations.
      const migrationsInput = normalizeMigrationsInput(news.migrations);
      const migrations = yield* runMigrations({
        input: migrationsInput,
        stamped: stampedOf(previous),
        withExecutor: (apply) =>
          makeDataApiMigrationExecutor({
            dialect: dialectOf(cluster.Engine),
            resourceArn: dbClusterArn,
            secretArn,
            database,
          }).pipe(Effect.flatMap(apply)),
      });

      yield* session.note(dbClusterArn);
      return {
        dbClusterArn,
        database,
        ...migrationsAttrs({ input: migrationsInput, run: migrations, output: previous }),
      };
    }),
    delete: Effect.fn(function* () {
      // Never drop tables or unwind migrations on teardown — the
      // database's contents outlive the stack by design.
    }),
  });
