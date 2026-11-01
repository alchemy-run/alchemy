import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class InvalidIdentifier extends Data.TaggedError("InvalidIdentifier")<{
  readonly message: string;
}> {}

type Engine = "postgres" | "mysql";

/** Databases and roles the server needs. A stage must never create or drop these. */
const SYSTEM_NAMES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "postgres",
  "rdsadmin",
  "rds_superuser",
  "root",
  "sys",
  "template0",
  "template1",
]);

/** The only names that reach SQL. Quoting isn't relied on to stop injection. */
export const isSafeIdentifier = (name: string) =>
  /^[a-z][a-z0-9_]{0,62}$/.test(name) && !SYSTEM_NAMES.has(name);

const assertName = Effect.fn(function* (name: string) {
  if (!isSafeIdentifier(name)) {
    return yield* new InvalidIdentifier({
      message: `${name} can't name a stage database: use lowercase letters, digits and underscores, and avoid system names.`,
    });
  }
});

/** Passwords come from `Alchemy.Random`, which is hex, and can't be sent as parameters here. */
const assertPassword = Effect.fn(function* (password: string) {
  if (!/^[0-9a-f]+$/.test(password)) {
    return yield* new InvalidIdentifier({ message: "A stage password must be hex." });
  }
});

/** Run these in order, each on its own, so `CREATE DATABASE` is outside a transaction. */
export const createStatements = Effect.fn(function* (
  engine: Engine,
  name: string,
  password: string,
) {
  yield* assertName(name);
  yield* assertPassword(password);
  return engine === "postgres"
    ? [
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE "${name}" LOGIN PASSWORD '${password}'; END IF; END $$`,
        `ALTER ROLE "${name}" WITH PASSWORD '${password}'`,
        // RDS's master isn't a superuser, and owning a database needs membership.
        `GRANT "${name}" TO CURRENT_USER`,
        `CREATE DATABASE "${name}" OWNER "${name}"`,
        `REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`,
      ]
    : [
        `CREATE DATABASE IF NOT EXISTS \`${name}\``,
        `CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED BY '${password}'`,
        `ALTER USER '${name}'@'%' IDENTIFIED BY '${password}'`,
        // `_` is a wildcard in a grant, so `a_b` would also cover `axb`.
        `GRANT ALL PRIVILEGES ON \`${name.replaceAll("_", "\\_")}\`.* TO '${name}'@'%'`,
      ];
});

export const dropStatements = Effect.fn(function* (engine: Engine, name: string) {
  yield* assertName(name);
  return engine === "postgres"
    ? [
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`,
        `DROP DATABASE IF EXISTS "${name}"`,
        `DROP ROLE IF EXISTS "${name}"`,
      ]
    : [`DROP DATABASE IF EXISTS \`${name}\``, `DROP USER IF EXISTS '${name}'@'%'`];
});

/** Returns a row when the database exists. */
export const readyQuery = Effect.fn(function* (engine: Engine, name: string) {
  yield* assertName(name);
  return engine === "postgres"
    ? `SELECT 1 FROM pg_database WHERE datname = '${name}'`
    : `SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`;
});
