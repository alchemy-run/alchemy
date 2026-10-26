import * as Azure from "@alchemy.run/azure";
import {
  ALCHEMY_DEFAULT_TABLE,
  applyMigrations,
  MigrationError,
  type SqlExecutor,
} from "@alchemy.run/sql/Migrations";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { SqlError } from "effect/sql/SqlError";
import { APP_ROLE, database } from "./database.ts";

/** Bookkeeping table: one row per applied migration. */
export const MIGRATIONS_TABLE = ALCHEMY_DEFAULT_TABLE;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HEX = /^[0-9a-f]+$/;

const migrationError = (cause: SqlError) => new MigrationError({ message: cause.message, cause });

/** The migration runner's view of an `@effect/sql-pg` client. */
const executorOf = (sql: PgClient.PgClient): SqlExecutor => ({
  dialect: "postgres",
  query: (statement, params) =>
    sql.unsafe<Record<string, unknown>>(statement, params).pipe(
      Effect.map((rows) => [...rows]),
      Effect.mapError(migrationError),
    ),
  batch: (statements) =>
    sql
      .withTransaction(Effect.forEach(statements, (statement) => sql.unsafe(statement)))
      .pipe(Effect.asVoid, Effect.mapError(migrationError)),
});

/**
 * Applies the drizzle-kit migrations in `./migrations` at deploy time, from
 * the deploying machine, then makes sure the API's role exists and can
 * read and write every table.
 *
 * Flexible servers accept public connections only from firewall rules, so
 * the deploy first looks up its own public IPv4 address and opens a
 * `Deployer` rule for it. The lookup runs again whenever the schema
 * changes, so a deploy from a new network still reaches the server.
 */
export const migrate = Effect.gen(function* () {
  const { server, db, appPassword, schema } = yield* database;

  const DeployerAddress = Alchemy.Action(
    "DeployerAddress",
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return Effect.fn(function* (_input: { snapshotHash: string }) {
        // A third-party lookup: `az postgres flexible-server create` uses the
        // same service to add its client-IP rule.
        const response = yield* http
          .get("https://api.ipify.org")
          .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 3 }));
        const body = yield* response.text;
        const address = body.trim();
        if (!IPV4.test(address)) {
          return yield* new MigrationError({
            message: `api.ipify.org returned "${address}", not an IPv4 address`,
          });
        }
        return address;
      });
    }),
  );
  const address = yield* DeployerAddress({ snapshotHash: schema.snapshotHash });

  const deployer = yield* Azure.PostgreSQL.FirewallRule("Deployer", {
    server: server.serverName,
    startIpAddress: address,
    endIpAddress: address,
  });

  const Migrate = Alchemy.Action(
    "Migrate",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return Effect.fn(function* (input: {
        adminUrl: Redacted.Redacted<string> | undefined;
        database: string;
        appPassword: Redacted.Redacted<string>;
        migrationsDir: string;
        snapshotHash: string;
        firewallRuleId: string;
      }) {
        if (input.adminUrl === undefined) {
          return yield* new MigrationError({
            message: "the server has no known administrator password (was it adopted?)",
          });
        }
        const password = Redacted.value(input.appPassword);
        if (!HEX.test(password)) {
          return yield* new MigrationError({ message: "the app password is not hex" });
        }

        // The administrator, connected to the app database.
        const url = new URL(Redacted.value(input.adminUrl));
        url.pathname = `/${input.database}`;
        const client = PgClient.layer({
          url: Redacted.make(url.toString()),
          maxConnections: 1,
          connectTimeout: "15 seconds",
        });

        // A firewall rule takes a few seconds to apply after ARM reports it.
        yield* Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`SELECT 1`;
        }).pipe(
          Effect.provide(client),
          Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 10 }),
        );

        yield* Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* applyMigrations({
            resolved: { dir: input.migrationsDir, table: MIGRATIONS_TABLE },
            executor: executorOf(sql),
          });
          // The password is hex (checked above), so it is safe to inline.
          yield* sql.withTransaction(
            Effect.forEach(
              [
                `DO $$ BEGIN
                  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
                    CREATE ROLE ${APP_ROLE} LOGIN;
                  END IF;
                END $$`,
                `ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${password}'`,
                `GRANT CONNECT ON DATABASE "${input.database}" TO ${APP_ROLE}`,
                `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
                `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
                `REVOKE ALL ON ${MIGRATIONS_TABLE} FROM ${APP_ROLE}`,
              ],
              (statement) => sql.unsafe(statement),
            ),
          );
        }).pipe(
          Effect.provide(client),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        return input.snapshotHash;
      });
    }),
  );

  return yield* Migrate({
    adminUrl: server.connectionString,
    database: db.databaseName,
    appPassword: appPassword.text,
    migrationsDir: schema.out,
    snapshotHash: schema.snapshotHash,
    firewallRuleId: deployer.firewallRuleId,
  });
});
