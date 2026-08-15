import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { Client } from "pg";
import {
  applyMigrations,
  MigrationError,
  resolveMigrations,
  type DrizzleV0LayoutError,
  type MigrationFormatMismatchError,
  type MigrationFormatUnsupportedError,
  type MigrationHistoryConflictError,
  type NormalizedMigrationsInput,
  type ResolvedMigrations,
  type SqlExecutor,
  type StampedMigrationsState,
} from "../SQL/Migrations/index.ts";
import { importPg } from "../SQL/PostgresDriver.ts";
import { hashMigrations } from "../SQL/SqlFile.ts";

export class PgError extends Data.TaggedError("PgError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Strip query-string SSL flags from a Neon connection URI. Neon's URIs
 * include `sslmode=require` and `channel_binding=require`, which trigger
 * a deprecation warning from `pg-connection-string`:
 *
 *   SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca'
 *   are treated as aliases for 'verify-full'.
 *
 * We control SSL programmatically via the `ssl` option below, so removing
 * the conflicting query params silences the warning without changing the
 * effective behavior.
 */
const stripSslQueryParams = (uri: string): string => {
  try {
    const url = new URL(uri);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    return uri;
  }
};

const toPgError = (cause: unknown) =>
  new PgError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Open a pg client for the scope of `use`, closing it afterwards. */
export const withPgClient = <A, E, R>(
  connectionUri: Redacted.Redacted<string>,
  use: (client: Client) => Effect.Effect<A, E, R>,
): Effect.Effect<A, PgError | E, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const { Client } = await importPg();
        const client = new Client({
          connectionString: stripSslQueryParams(Redacted.value(connectionUri)),
          ssl: { rejectUnauthorized: false },
        });
        await client.connect();
        return client;
      },
      catch: toPgError,
    }),
    use,
    (client) => Effect.promise(() => client.end().catch(() => {})),
  );

/**
 * Adapt an open pg client into the registry's {@link SqlExecutor}. Batches
 * run in a transaction so a migration and its bookkeeping INSERT commit
 * (or roll back) together.
 */
export const makePgMigrationExecutor = (client: Client): SqlExecutor => ({
  dialect: "postgres",
  query: (sql, params) =>
    Effect.tryPromise({
      try: () =>
        client
          .query(sql, (params ?? []) as unknown[])
          .then((result) => result.rows as Array<Record<string, unknown>>),
      catch: (cause) =>
        new MigrationError({
          message: `postgres query failed: ${String(cause)}`,
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.tryPromise({
      try: async () => {
        await client.query("BEGIN");
        try {
          for (const statement of statements) {
            await client.query(statement);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
      catch: (cause) =>
        new MigrationError({
          message: `postgres migration batch failed: ${String(cause)}`,
          cause,
        }),
    }),
});

export type PgMigrationError =
  | PgError
  | MigrationError
  | MigrationFormatMismatchError
  | MigrationFormatUnsupportedError
  | MigrationHistoryConflictError
  | DrizzleV0LayoutError;

/**
 * Resolve the migration format for `input` and apply pending migrations
 * over the given connection. Inline formats (`drizzle`/`alchemy`) run
 * through a scoped pg client; the `prisma` format delegates to
 * `prisma migrate deploy` with the connection URI and never opens a client
 * of ours. Returns the resolved format/table (for stamping into state) and
 * the per-file content hashes (for drift detection).
 */
export const runPgMigrations = (options: {
  connectionUri: Redacted.Redacted<string>;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}): Effect.Effect<
  { resolved: ResolvedMigrations; hashes: Record<string, string> },
  PgMigrationError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const hashes = yield* hashMigrations(options.input.dir).pipe(
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `Failed to read migrations from ${options.input.dir}: ${String(cause)}`,
            cause,
          }),
      ),
    );
    const resolved = yield* resolveMigrations({
      input: options.input,
      stamped: options.stamped,
      dialect: "postgres",
    });
    if (Object.keys(hashes).length > 0) {
      if (resolved.format === "prisma") {
        yield* applyMigrations({
          resolved,
          connectionUrl: options.connectionUri,
        });
      } else {
        yield* withPgClient(options.connectionUri, (client) =>
          applyMigrations({
            resolved,
            executor: makePgMigrationExecutor(client),
          }),
        );
      }
    }
    return { resolved, hashes };
  });

/**
 * Run a single SQL script against the database (used for `importFiles`).
 */
export const runSql = (connectionUri: Redacted.Redacted<string>, sql: string) =>
  withPgClient(connectionUri, (client) =>
    Effect.tryPromise({
      try: () => client.query(sql),
      catch: toPgError,
    }),
  ).pipe(Effect.asVoid);
