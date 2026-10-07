import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Client } from "pg";
import {
  makePgMigrationExecutor,
  MigrationError,
  runMigrations,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "../../SQL/Migrations/index.ts";
import { importPg } from "../../SQL/PostgresDriver.ts";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";

/**
 * Aurora DSQL allows a single DDL statement per transaction and never mixes
 * DDL with DML, so every statement of a batch commits on its own.
 */
const makeDsqlMigrationExecutor = (client: Client): SqlExecutor => {
  const pg = makePgMigrationExecutor(client);
  return {
    dialect: "postgres",
    idColumn: "identity",
    query: pg.query,
    batch: (statements) => Effect.forEach(statements, (sql) => pg.query(sql), { discard: true }),
  };
};

/** Open a pg client as the cluster's `admin` role for the scope of `use`. */
export const withDsqlAdminClient = <A, E, R>(
  endpoint: string,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const password = yield* generateDbAuthToken({
      service: "dsql",
      hostname: endpoint,
      action: "DbConnectAdmin",
    });
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          importPg().then(({ Client }) => {
            const client = new Client({
              host: endpoint,
              port: 5432,
              user: "admin",
              database: "postgres",
              password: Redacted.value(password),
              ssl: true,
            });
            return client.connect().then(() => client);
          }),
        catch: (cause) =>
          new MigrationError({
            message: `Failed to connect to DSQL cluster ${endpoint}: ${String(cause)}`,
            cause,
          }),
      }),
      use,
      (client) => Effect.promise(() => client.end().catch(() => {})),
    );
  });

/**
 * The shared migration pipeline over an IAM-authenticated `admin`
 * connection to the cluster's `postgres` database.
 */
export const runDsqlMigrations = (options: {
  endpoint: string;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) =>
  runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      withDsqlAdminClient(options.endpoint, (client) => apply(makeDsqlMigrationExecutor(client))),
  });
