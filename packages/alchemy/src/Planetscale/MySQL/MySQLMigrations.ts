import * as ps from "@distilled.cloud/planetscale";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Connection } from "mysql2/promise";
import {
  applyMigrations,
  MigrationError,
  resolveMigrations,
  type NormalizedMigrationsInput,
  type ResolvedMigrations,
  type SqlExecutor,
  type StampedMigrationsState,
} from "../../SQL/Migrations/index.ts";
import {
  hashMigrations,
  readSqlFile,
  splitSqlStatements,
} from "../../SQL/SqlFile.ts";

const MIGRATION_PASSWORD_TTL_SECONDS = 600;

// `mysql2` is an optional peer dependency — loaded lazily so importing the
// Planetscale provider never requires the driver unless migrations run.
const importMysql = () =>
  import("mysql2/promise").catch((cause) => {
    throw new Error(
      "Failed to load the 'mysql2' driver. Install the optional peer dependency 'mysql2' to run Planetscale MySQL migrations.",
      { cause },
    );
  });

export class MySQLMigrationError extends Data.TaggedError(
  "Planetscale::MySQLMigrationError",
)<{
  message: string;
  cause?: unknown;
}> {}

export interface MySQLMigrationTarget {
  organization: string;
  database: string;
  branch: string;
}

/**
 * Adapt an open mysql2 connection into the registry's SqlExecutor. Batches
 * run in a transaction (MySQL DDL auto-commits, matching the previous
 * behavior of statement-by-statement application).
 */
const makeMySQLMigrationExecutor = (connection: Connection): SqlExecutor => ({
  dialect: "mysql",
  query: (sql, params) =>
    Effect.tryPromise({
      try: () =>
        connection
          .query(sql, params ? [...params] : undefined)
          .then(([rows]) => rows as Array<Record<string, unknown>>),
      catch: (cause) =>
        new MigrationError({
          message: `mysql query failed: ${String(cause)}`,
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.tryPromise({
      try: async () => {
        await connection.query("START TRANSACTION");
        try {
          for (const statement of statements) {
            await connection.query(statement);
          }
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
      catch: (cause) =>
        new MigrationError({
          message: `mysql migration batch failed: ${String(cause)}`,
          cause,
        }),
    }),
});

/**
 * Resolve the migration format for `input` and apply pending migrations
 * against the branch through a temporary admin password. Inline formats
 * run through a scoped mysql2 connection; foreign (drizzle/prisma) or
 * legacy history is converted one-way into Alchemy's table. Returns the
 * resolved format/table (for stamping) and per-file content hashes.
 */
export const runMySQLMigrations = (
  target: MySQLMigrationTarget,
  input: NormalizedMigrationsInput,
  stamped: StampedMigrationsState,
) =>
  Effect.gen(function* () {
    const hashes = yield* hashMigrations(input.dir).pipe(
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `Failed to read migrations from ${input.dir}: ${String(cause)}`,
            cause,
          }),
      ),
    );
    const resolved: ResolvedMigrations = resolveMigrations({ input, stamped });
    if (Object.keys(hashes).length > 0) {
      yield* withMySQLConnection(target, (connection) =>
        applyMigrations({
          resolved,
          executor: makeMySQLMigrationExecutor(connection),
        }),
      );
    }
    return { resolved, hashes };
  });

export const runMySQLImports = (
  target: MySQLMigrationTarget,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = { ...previous };
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      if (previous[filePath] === file.hash) {
        hashes[filePath] = file.hash;
        continue;
      }
      yield* runMySQLSql(target, file.sql);
      hashes[filePath] = file.hash;
    }
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });

const runMySQLSql = (target: MySQLMigrationTarget, sql: string) =>
  withMySQLConnection(target, (connection) =>
    Effect.gen(function* () {
      for (const statement of splitSqlStatements(sql)) {
        yield* mysqlQuery(connection, statement);
      }
    }),
  );

const withMySQLConnection = <A, E, R>(
  target: MySQLMigrationTarget,
  use: (connection: Connection) => Effect.Effect<A, E, R>,
) =>
  withTemporaryMySQLPassword(target, (password) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const { createConnection } = await importMysql();
          return createConnection({
            host: password.host,
            user: password.username,
            password: Redacted.value(password.password),
            database: target.database,
            multipleStatements: true,
            ssl: { rejectUnauthorized: true },
          });
        },
        catch: toMigrationError,
      }),
      use,
      (connection) =>
        Effect.tryPromise({
          try: () => connection.end(),
          catch: toMigrationError,
        }).pipe(Effect.catch(() => Effect.void)),
    ),
  );

const withTemporaryMySQLPassword = <A, E, R>(
  target: MySQLMigrationTarget,
  use: (password: {
    id: string;
    host: string;
    username: string;
    password: Redacted.Redacted<string>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const created = yield* ps.createPassword({
        organization: target.organization,
        database: target.database,
        branch: target.branch,
        role: "admin",
        ttl: MIGRATION_PASSWORD_TTL_SECONDS,
      });

      return {
        id: created.id,
        host: created.access_host_url,
        username: created.username,
        password: created.plain_text,
      };
    }),
    use,
    (password) =>
      ps
        .deletePassword({
          organization: target.organization,
          database: target.database,
          branch: target.branch,
          id: password.id,
        })
        .pipe(
          // Already-deleted passwords are a success: nothing to clean up.
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(5),
            ]),
          }),
          // Migrations succeeded; don't fail the parent over a release-step
          // hiccup. The password's TTL bounds the orphan window; log loudly
          // so an operator can clean it up manually if needed.
          Effect.catch((cause: unknown) =>
            Effect.logWarning(
              `Failed to delete temporary Planetscale migration password after retries. ` +
                `It will expire via TTL (~${MIGRATION_PASSWORD_TTL_SECONDS}s). ` +
                `organization=${target.organization} database=${target.database} ` +
                `branch=${target.branch} id=${password.id}`,
              cause,
            ),
          ),
        ),
  );

const mysqlQuery = (connection: Connection, sql: string) =>
  Effect.tryPromise({
    try: () => connection.query(sql).then(() => undefined),
    catch: toMigrationError,
  });

const toMigrationError = (cause: unknown) =>
  new MySQLMigrationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
