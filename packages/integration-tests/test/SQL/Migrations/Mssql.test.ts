import {
  applyAlchemyFormat,
  classifyTable,
  quoteIdentifier,
  splitTsqlBatches,
  tableColumns,
  withMssqlExecutor,
  type MigrationRecord,
  type SqlExecutor,
} from "@alchemy.run/sql/Migrations";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const tags = { tags: ["unit", "local"] };

describe("splitTsqlBatches", () => {
  it.effect(
    "splits on GO lines, in any case, with a count or a trailing comment",
    () =>
      Effect.sync(() => {
        expect(
          splitTsqlBatches("SELECT 1;\nGO\nSELECT 2;\ngo  -- done\r\nSELECT 3;\nGo 2\n"),
        ).toEqual(["SELECT 1;", "SELECT 2;", "SELECT 3;", "SELECT 3;"]);
      }),
    tags,
  );

  it.effect(
    "ignores GO inside strings, quoted identifiers and comments",
    () =>
      Effect.sync(() => {
        const string = "SELECT 'a\nGO\nb';";
        const bracket = "SELECT [a]]\nGO\nb] FROM t;";
        const quoted = 'SELECT "a\nGO\nb";';
        const comment = "SELECT 1 /* outer\n/* nested */\nGO\n*/;";
        const line = "-- GO\nSELECT 1;";
        for (const sql of [string, bracket, quoted, comment, line]) {
          expect(splitTsqlBatches(sql)).toEqual([sql]);
        }
      }),
    tags,
  );

  it.effect(
    "only a whole line counts, and a comment-only batch is dropped",
    () =>
      Effect.sync(() => {
        expect(splitTsqlBatches("SELECT GO;\nGOTO x;\nGO; \n")).toEqual([
          "SELECT GO;\nGOTO x;\nGO;",
        ]);
        expect(splitTsqlBatches("-- header\nGO\nSELECT 1;\nGO\n/* end */\n")).toEqual([
          "SELECT 1;",
        ]);
        expect(splitTsqlBatches("")).toEqual([]);
      }),
    tags,
  );
});

// The T-SQL half of the shared engine, against a real SQL Server. Needs no cloud.
const CONTAINER = "alchemy-test-mssql-migrations";
const PASSWORD = "Alchemy_Test_Pass_1!";
const IMAGE = "mcr.microsoft.com/mssql/server:2022-latest";

const docker = (args: string[]) =>
  Effect.sync(() => Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" }));

const sqlServer = Effect.acquireRelease(
  Effect.gen(function* () {
    yield* docker(["rm", "-f", CONTAINER]);
    const started = yield* docker([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "ACCEPT_EULA=Y",
      "-e",
      `MSSQL_SA_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1::1433",
      IMAGE,
    ]);
    if (started.exitCode !== 0) {
      return yield* Effect.die(new Error(`docker run failed: ${started.stderr.toString()}`));
    }
    const mapped = yield* docker(["port", CONTAINER, "1433/tcp"]);
    return Number(mapped.stdout.toString().trim().split(":").at(-1));
  }),
  () => docker(["rm", "-f", CONTAINER]),
);

const config = (port: number, database: string) => ({
  server: "127.0.0.1",
  port,
  database,
  user: "sa",
  password: PASSWORD,
  // The container's certificate is self-signed.
  options: { encrypt: true, trustServerCertificate: true },
});

const record = (name: string, sql: string): MigrationRecord => ({
  name,
  hash: `hash-of-${name}`,
  createdAtMillis: 1_700_000_000_000,
  sql,
  statements: [sql],
});

const USERS = record(
  "0001_users.sql",
  [
    "CREATE TABLE users (id INT PRIMARY KEY, name NVARCHAR(50));",
    "GO",
    "CREATE PROCEDURE add_user @id INT AS",
    "BEGIN",
    "  INSERT INTO users (id, name) VALUES (@id, N'go; GO');",
    "END",
    "GO",
    "EXEC add_user 1;",
  ].join("\n"),
);
const POSTS = record("0002_posts.sql", "CREATE TABLE posts (id INT PRIMARY KEY);");
const TABLE = "__alchemy_migrations";

const history = (executor: SqlExecutor, table = TABLE) =>
  executor
    .query(`SELECT name, hash FROM ${quoteIdentifier(table, "mssql")} ORDER BY id;`)
    .pipe(Effect.map((rows) => rows.map((row) => row.name)));

const tablesNamed = (executor: SqlExecutor, ...names: string[]) =>
  executor
    .query(
      `SELECT name FROM sys.tables WHERE name IN (${names.map((name) => `N'${name}'`).join(", ")});`,
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.name)));

describe.sequential("the shared engine on SQL Server", () => {
  it.live.skipIf(!!process.env.FAST)(
    "applies, records, rolls back and converts history",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const port = yield* sqlServer;

          // The server takes a while to accept logins after the container starts.
          yield* withMssqlExecutor(config(port, "master"), (executor) =>
            executor.query("CREATE DATABASE engine_test;"),
          ).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));

          yield* withMssqlExecutor(config(port, "engine_test"), (executor) =>
            Effect.gen(function* () {
              expect(classifyTable(yield* tableColumns(executor, TABLE))).toEqual("absent");

              // `GO` separates batches, so a file can hold CREATE PROCEDURE.
              yield* applyAlchemyFormat({ executor, table: TABLE, records: [USERS] });
              expect(yield* history(executor)).toEqual(["0001_users.sql"]);
              expect(yield* executor.query("SELECT id, name FROM users;")).toEqual([
                { id: 1, name: "go; GO" },
              ]);
              expect(classifyTable(yield* tableColumns(executor, TABLE))).toEqual("drizzle-shaped");

              // Only the pending file runs: the first would fail on its table.
              yield* applyAlchemyFormat({ executor, table: TABLE, records: [USERS, POSTS] });
              expect(yield* history(executor)).toEqual(["0001_users.sql", "0002_posts.sql"]);

              // A failing file leaves nothing behind, across `GO` batches too, and
              // the error is the database's own.
              const failing = record(
                "0003_failing.sql",
                [
                  "CREATE TABLE before_go (id INT);",
                  "GO",
                  "CREATE TABLE half (id INT PRIMARY KEY);",
                  "INSERT INTO half VALUES (1);",
                  "INSERT INTO half VALUES (1);",
                  "CREATE TABLE after_failure (id INT);",
                ].join("\n"),
              );
              const failed = yield* applyAlchemyFormat({
                executor,
                table: TABLE,
                records: [USERS, POSTS, failing],
              }).pipe(Effect.flip);
              expect(failed._tag).toEqual("MigrationError");
              expect(failed.message).toContain("PRIMARY KEY");
              expect(yield* tablesNamed(executor, "before_go", "half", "after_failure")).toEqual(
                [],
              );
              expect(yield* history(executor)).toEqual(["0001_users.sql", "0002_posts.sql"]);

              // An applied file that changed is refused.
              const rewritten = yield* applyAlchemyFormat({
                executor,
                table: TABLE,
                records: [{ ...USERS, hash: "changed" }, POSTS],
              }).pipe(Effect.flip);
              expect(rewritten._tag).toEqual("RewrittenMigrationHistoryError");

              // A legacy table is rebuilt in place, which renames through `sp_rename`.
              yield* executor.batch([
                "CREATE TABLE legacy (id NVARCHAR(200) PRIMARY KEY, name NVARCHAR(200), applied_at DATETIMEOFFSET);",
                "INSERT INTO legacy (id, name) VALUES (N'a', N'0001_users.sql');",
              ]);
              yield* applyAlchemyFormat({ executor, table: "legacy", records: [USERS] });
              expect(yield* tablesNamed(executor, "legacy", "legacy_alchemy_upgrade")).toEqual([
                "legacy",
              ]);
              expect(yield* executor.query("SELECT name, hash FROM legacy;")).toEqual([
                { name: "0001_users.sql", hash: USERS.hash },
              ]);

              // Prisma's history is converted once, keeping its checksums.
              yield* executor.batch([
                "CREATE TABLE _prisma_migrations (id NVARCHAR(36) PRIMARY KEY, checksum NVARCHAR(64) NOT NULL, finished_at DATETIMEOFFSET, migration_name NVARCHAR(255) NOT NULL, rolled_back_at DATETIMEOFFSET, started_at DATETIMEOFFSET);",
                "INSERT INTO _prisma_migrations VALUES (N'x', N'prisma-checksum', SYSDATETIMEOFFSET(), N'20260101000000_init', NULL, SYSDATETIMEOFFSET());",
              ]);
              yield* applyAlchemyFormat({
                executor,
                table: "converted",
                records: [
                  { ...record("20260101000000_init", "SELECT 1;"), hash: "prisma-checksum" },
                ],
              });
              expect(yield* executor.query("SELECT name, hash FROM converted;")).toEqual([
                { name: "20260101000000_init", hash: "prisma-checksum" },
              ]);

              // Identifiers quote with brackets, and literals keep Unicode.
              yield* executor.batch([
                `CREATE TABLE ${quoteIdentifier("we]ird", "mssql")} (id INT);`,
              ]);
              expect(yield* tablesNamed(executor, "we]ird")).toEqual(["we]ird"]);
              expect(yield* executor.query("SELECT ? AS value;", ["ünï'code✓"])).toEqual([
                { value: "ünï'code✓" },
              ]);
            }),
          );
        }),
      ),
    { tags: ["local"], timeout: 300_000 },
  );
});
