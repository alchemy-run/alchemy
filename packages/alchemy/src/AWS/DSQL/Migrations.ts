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
import { connectPgClient, withPgClient } from "../../SQL/PostgresDriver.ts";
import { dsqlConnectionInfo } from "./ConnectionInfo.ts";

const isDml = (sql: string): boolean =>
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:insert|update|delete)\b/i.test(sql);

/**
 * Split statements into transaction units. Aurora DSQL allows a single DDL
 * statement per transaction and never mixes DDL with DML, so each DDL (or
 * unrecognized) statement stands alone while consecutive DML statements —
 * e.g. a migration's data fix-ups and its bookkeeping INSERT — commit
 * together.
 */
const transactionUnits = (statements: ReadonlyArray<string>): string[][] => {
  const units: string[][] = [];
  let dml: string[] | undefined;
  for (const sql of statements) {
    if (!isDml(sql)) {
      units.push([sql]);
      dml = undefined;
      continue;
    }
    if (dml === undefined) {
      dml = [];
      units.push(dml);
    }
    dml.push(sql);
  }
  return units;
};

const makeDsqlMigrationExecutor = (client: Client): SqlExecutor => {
  const pg = makePgMigrationExecutor(client);
  return {
    ...pg,
    batch: (statements) =>
      Effect.forEach(transactionUnits(statements), (unit) => pg.batch(unit), { discard: true }),
  };
};

/** Open a pg client as the cluster's `admin` role for the scope of `use`. */
export const withDsqlAdminClient = <A, E, R>(
  endpoint: string,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const info = yield* dsqlConnectionInfo({ host: endpoint, admin: true });
    return yield* withPgClient(
      connectPgClient(
        {
          host: info.host,
          port: info.port,
          user: info.username,
          database: info.database,
          password: Redacted.value(info.password),
          ssl: info.ssl,
        },
        (cause) =>
          new MigrationError({
            message: `Failed to connect to DSQL cluster ${endpoint}: ${String(cause)}`,
            cause,
          }),
      ),
      use,
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
