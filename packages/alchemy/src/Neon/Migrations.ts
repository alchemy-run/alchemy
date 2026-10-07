import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Client } from "pg";
import {
  makePgMigrationExecutor,
  runMigrations,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "../SQL/Migrations/index.ts";
import {
  connectPgClient,
  stripSslQueryParams,
  withPgClient as withConnectedPgClient,
} from "../SQL/PostgresDriver.ts";

export class PgError extends Data.TaggedError("PgError")<{
  message: string;
  cause?: unknown;
}> {}

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
  withConnectedPgClient(
    connectPgClient(
      {
        connectionString: stripSslQueryParams(Redacted.value(connectionUri)),
        ssl: { rejectUnauthorized: false },
      },
      toPgError,
    ),
    use,
  );

/**
 * Neon's migration adaptation is exactly this: the shared pipeline with a
 * connection-URI-scoped pg client as its executor.
 */
export const runPgMigrations = (options: {
  connectionUri: Redacted.Redacted<string>;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) =>
  runMigrations({
    ...options,
    withExecutor: (apply) =>
      withPgClient(options.connectionUri, (client) => apply(makePgMigrationExecutor(client))),
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
