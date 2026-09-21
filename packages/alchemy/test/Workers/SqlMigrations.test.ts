import type { MigrationRecord } from "@/SQL/Migrations/Format.ts";
import {
  applySqlMigrations,
  makeAsyncSqlExecutor,
  makeSyncSqlExecutor,
  type NativeSqlQuery,
} from "@/Workers/SqlMigrationsApply.ts";
import type { SqlMigrationSnapshot } from "@/Workers/SqlMigrationsRuntime.ts";
import { describe, expect, it } from "alchemy-test";
import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

const record = (name: string, statements: string[]): MigrationRecord => ({
  name,
  hash: `hash-${name}`,
  createdAtMillis: undefined,
  sql: statements.join("\n"),
  statements,
});
const snapshot = (records: MigrationRecord[]): SqlMigrationSnapshot => ({
  _tag: "Cloudflare.SqlMigrations",
  table: "app_migrations",
  records,
});
const database = Effect.acquireRelease(
  Effect.sync(() => new Database(":memory:")),
  (db) => Effect.sync(() => db.close()),
);
const query = (db: Database, sql: string) =>
  db.query(sql).all() as Array<Record<string, unknown>>;

for (const mode of ["sync", "async"] as const) {
  const executor = (db: Database) => {
    if (mode === "sync") {
      return makeSyncSqlExecutor({
        sql: {
          exec: (sql) => {
            const rows = query(db, sql);
            return { toArray: () => rows };
          },
        },
        transactionSync: (run) => db.transaction(run)(),
      });
    }
    const nativeQuery: NativeSqlQuery = (sql) =>
      Effect.sync(() => query(db, sql)).pipe(Effect.runPromise);
    return makeAsyncSqlExecutor({
      query: nativeQuery,
      transaction: (run) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => db.exec("BEGIN"));
          yield* Effect.promise(() => run(nativeQuery)).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() =>
                db.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK"),
              ),
            ),
          );
        }).pipe(Effect.runPromise),
    });
  };

  describe(`shared SQL migrations (${mode} native transaction adapter)`, () => {
    it.effect(
      "commits each file with history and rolls back only the failing file",
      () =>
        Effect.gen(function* () {
          const db = yield* database;
          const sql = executor(db);
          const first = record("0001_users.sql", [
            "CREATE TABLE users (id INTEGER)",
          ]);
          const broken = record("0002_posts.sql", [
            "CREATE TABLE posts (id INTEGER)",
            "INSERT INTO missing_table VALUES (1)",
          ]);
          const result = yield* applySqlMigrations(
            snapshot([first, broken]),
            sql,
          ).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe("MigrationError");
          expect(yield* sql.query("SELECT name FROM app_migrations")).toEqual([
            { name: first.name },
          ]);
          expect(
            yield* sql.query(
              "SELECT name FROM sqlite_master WHERE name = 'posts'",
            ),
          ).toEqual([]);
          yield* applySqlMigrations(
            snapshot([
              first,
              record(broken.name, ["CREATE TABLE posts (id INTEGER)"]),
            ]),
            sql,
          );
          yield* applySqlMigrations(
            snapshot([
              first,
              record(broken.name, ["CREATE TABLE posts (id INTEGER)"]),
            ]),
            sql,
          );
          expect(
            yield* sql.query("SELECT name FROM app_migrations ORDER BY id"),
          ).toEqual([{ name: first.name }, { name: broken.name }]);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "adopts modern Drizzle history and honors legacy directory aliases",
      () =>
        Effect.gen(function* () {
          const db = yield* database;
          const sql = executor(db);
          const first = record("20240101000000_users", [
            "CREATE TABLE users (id INTEGER)",
          ]);
          yield* sql.batch([
            "CREATE TABLE users (id INTEGER)",
            "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT)",
            `INSERT INTO __drizzle_migrations VALUES (1, '${first.hash}', NULL, '${first.name}/migration.sql', '2024-01-01')`,
          ]);
          yield* applySqlMigrations(snapshot([first]), sql);
          expect(
            yield* sql.query("SELECT name FROM app_migrations"),
          ).toHaveLength(1);
          yield* applySqlMigrations(
            snapshot([
              {
                ...first,
                hash: "changed",
                statements: ["INVALID SQL MUST NOT RUN"],
              },
            ]),
            sql,
          );
          expect(
            yield* sql.query("SELECT name FROM app_migrations"),
          ).toHaveLength(1);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "preserves legacy Alchemy history and rejects unmatched foreign rows",
      () =>
        Effect.gen(function* () {
          const db = yield* database;
          const sql = executor(db);
          const first = record("0001_users.sql", [
            "CREATE TABLE users (id INTEGER)",
          ]);
          yield* sql.batch([
            "CREATE TABLE users (id INTEGER)",
            "CREATE TABLE app_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
            "INSERT INTO app_migrations VALUES ('1', '0001_users.sql', '2024-01-01')",
          ]);
          yield* applySqlMigrations(snapshot([first]), sql);
          expect(
            yield* sql.query(
              "SELECT name, hash, applied_at FROM app_migrations",
            ),
          ).toEqual([
            { name: first.name, hash: first.hash, applied_at: "2024-01-01" },
          ]);
          yield* sql.batch([
            "DROP TABLE app_migrations",
            "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT)",
            "INSERT INTO __drizzle_migrations VALUES (1, 'missing', NULL, 'missing.sql', NULL)",
          ]);
          const result = yield* applySqlMigrations(snapshot([first]), sql).pipe(
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe("MigrationHistoryConflictError");
          expect(
            yield* sql.query(
              "SELECT name FROM sqlite_master WHERE name = 'app_migrations'",
            ),
          ).toEqual([]);
        }).pipe(Effect.scoped),
    );
  });
}

it.effect("uses only the native leased query for each asynchronous batch", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    const executor = makeAsyncSqlExecutor({
      query: () =>
        Effect.die("batch must use its transaction lease").pipe(
          Effect.runPromise,
        ),
      transaction: (run) => {
        const lease: string[] = [];
        calls.push(lease);
        return run((sql) =>
          Effect.sync(() => {
            lease.push(sql);
            return [];
          }).pipe(Effect.runPromise),
        );
      },
    });
    yield* executor.batch(["first", "history"]);
    yield* executor.batch(["second", "history"]);
    expect(calls).toEqual([
      ["first", "history"],
      ["second", "history"],
    ]);
  }),
);
