import * as Effect from "effect/Effect";
import { MigrationError, type SqlExecutor } from "../../SQL/Migrations/Format.ts";
import { makeMySQLMigrationExecutor } from "../../SQL/Migrations/MySQLExecutor.ts";
import { makePgMigrationExecutor } from "../../SQL/Migrations/PgExecutor.ts";
import { importMySql } from "../../SQL/MySQLDriver.ts";
import { importPg } from "../../SQL/PostgresDriver.ts";

/**
 * Where and as whom a migration connects. Plain JSON: the Lambda transport
 * sends it to the migration runner in the invocation payload.
 */
export interface MigrationConnectionTarget {
  dialect: "postgres" | "mysql";
  host: string;
  port: number;
  database: string | undefined;
  username: string;
  password: string;
}

// Fail fast on an unreachable endpoint instead of hanging the deploy.
const CONNECT_TIMEOUT_MILLIS = 15_000;

const toMigrationError = (context: string) => (cause: unknown) =>
  new MigrationError({
    message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

/**
 * Open one `pg` client or `mysql2` connection to an RDS endpoint for the
 * scope of `use`, closing it afterwards. Shared by the direct transport
 * (on the deploying machine) and the migration runner Lambda (in the VPC).
 *
 * TLS is always on. RDS certificates chain to a private AWS CA that Node's
 * trust store doesn't carry, so the certificate is not verified.
 */
export const withMigrationConnection = <A, E, R>(
  target: MigrationConnectionTarget,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
): Effect.Effect<A, MigrationError | E, R> =>
  target.dialect === "postgres"
    ? Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            const { Client } = await importPg();
            const client = new Client({
              host: target.host,
              port: target.port,
              database: target.database,
              user: target.username,
              password: target.password,
              ssl: { rejectUnauthorized: false },
              connectionTimeoutMillis: CONNECT_TIMEOUT_MILLIS,
            });
            await client.connect();
            return client;
          },
          catch: toMigrationError(`Failed to connect to ${target.host}:${target.port}`),
        }),
        (client) => use(makePgMigrationExecutor(client)),
        (client) => Effect.promise(() => client.end().catch(() => {})),
      )
    : Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            const { createConnection } = await importMySql();
            return createConnection({
              host: target.host,
              port: target.port,
              database: target.database,
              user: target.username,
              password: target.password,
              ssl: { rejectUnauthorized: false },
              connectTimeout: CONNECT_TIMEOUT_MILLIS,
            });
          },
          catch: toMigrationError(`Failed to connect to ${target.host}:${target.port}`),
        }),
        (connection) => use(makeMySQLMigrationExecutor(connection)),
        (connection) => Effect.promise(() => connection.end().catch(() => {})),
      );
