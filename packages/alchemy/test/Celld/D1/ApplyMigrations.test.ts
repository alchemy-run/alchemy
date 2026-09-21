import {
  applyD1MigrationRecords,
  migrationLockKey,
} from "@/Celld/D1/ApplyMigrations.ts";
import {
  FleetStorageError,
  type Store,
  type StoredObject,
} from "@/Celld/FleetStorage.ts";
import {
  OperatorError,
  type FleetOperatorService,
} from "@/Celld/OperatorClient.ts";
import type { MigrationRecord } from "@/SQL/Migrations/index.ts";
import { expect, test } from "alchemy-test";
import { Database as Sqlite } from "bun:sqlite";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { createHash } from "node:crypto";

const record = (name: string, sql: string): Effect.Effect<MigrationRecord> =>
  Effect.sync(() => ({
    name,
    sql,
    hash: createHash("sha256").update(sql).digest("hex"),
    statements: [sql],
    createdAtMillis: undefined,
  }));

const fixture = Effect.gen(function* () {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new Sqlite(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );
  const objects = new Map<string, StoredObject>();
  let serial = 0;
  const conflict = () =>
    new FleetStorageError({
      reason: "conflict",
      message: "conditional write failed",
    });
  const store: Store = {
    get: (key) => Effect.sync(() => objects.get(key)),
    put: (key, body, condition) =>
      Effect.gen(function* () {
        const old = objects.get(key);
        if (
          (condition?.ifNoneMatch && old) ||
          (condition?.ifMatch && old?.etag !== condition.ifMatch)
        )
          return yield* Effect.fail(conflict());
        const value = { body, etag: String(++serial) };
        objects.set(key, value);
        return { etag: value.etag };
      }),
    delete: (key, condition) =>
      Effect.gen(function* () {
        if (condition?.ifMatch && objects.get(key)?.etag !== condition.ifMatch)
          return yield* Effect.fail(conflict());
        objects.delete(key);
      }),
    list: (prefix) =>
      Effect.sync(() =>
        [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, etag: value.etag })),
      ),
  };
  const control = {
    migrations: 0,
    queries: 0,
    loseResponse: false,
    failReads: false,
    beforeMigrate: Effect.void as Effect.Effect<void>,
  };
  const failure = () => new OperatorError({ message: "test operator failed" });
  const operator: FleetOperatorService = {
    execD1: () => Effect.fail(failure()),
    executeD1Statements: (_connection, input) =>
      Effect.try({
        try: () => {
          control.queries++;
          expect(objects.has(migrationLockKey("database"))).toBe(true);
          if (control.failReads) throw new Error("unavailable");
          return {
            result: input.statements.map((statement) => {
              const query = db.query(statement.sql);
              const rows = query.values(...((statement.params ?? []) as any[]));
              return { columns: query.columnNames, rows };
            }),
          };
        },
        catch: failure,
      }),
    migrateD1: (_connection, input) =>
      Effect.gen(function* () {
        control.migrations++;
        yield* control.beforeMigrate;
        const result = yield* Effect.try({
          try: () => {
            db.transaction(() => {
              // Bun's multi-statement exec can hide an earlier step error.
              let remaining = input.migrate.sql;
              while (
                (remaining = remaining.replace(/^[\s;]+/, "")).length > 0
              ) {
                const statement = db.prepare(remaining);
                const consumed = statement.toString().length;
                statement.run();
                statement.finalize();
                remaining = remaining.slice(consumed);
              }
              db.exec(
                `CREATE TABLE IF NOT EXISTS "${input.migrate.table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
              );
              db.query(
                `INSERT INTO "${input.migrate.table}" (name) VALUES (?)`,
              ).run(input.migrate.name);
            })();
            return { result: { count: 1, duration: 0 } };
          },
          catch: failure,
        });
        if (control.loseResponse) return yield* Effect.fail(failure());
        return result;
      }),
  };
  const apply = (records: MigrationRecord[]) =>
    applyD1MigrationRecords({
      connection: {
        fleetId: "Fleet",
        fleetUrl: "http://node",
        bucket: { uri: "s3://test" },
        hostState: undefined,
      },
      databaseId: "database",
      table: "__alchemy_migrations",
      records,
      store,
      operator,
    });
  return { db, objects, store, control, apply };
});

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

test(
  "migrations use Alchemy hashes and are idempotent across repeated reconciles",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const records = [
          yield* record(
            "0001.sql",
            "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);",
          ),
          yield* record("0002.sql", "INSERT INTO users VALUES (1, 'Ada');"),
        ];
        yield* f.apply(records);
        const calls = f.control.migrations;
        yield* f.apply(records);
        expect(f.control.migrations).toBe(calls);
        yield* Effect.sync(() => {
          expect(
            f.db
              .query("SELECT name, hash FROM __alchemy_migrations ORDER BY id")
              .all(),
          ).toEqual(records.map(({ name, hash }) => ({ name, hash })));
          expect(f.db.query("SELECT * FROM users").all()).toEqual([
            { id: 1, name: "Ada" },
          ]);
        });
        expect(f.objects.size).toBe(0);
      }),
    ),
  { timeout: 30_000 },
);

test(
  "changed hashes and conflicting histories fail before migration SQL",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* record("0001.sql", "CREATE TABLE t(x);");
        yield* f.apply([first]);
        const before = f.control.migrations;
        const changed = yield* record("0001.sql", "CREATE TABLE changed(x);");
        expect(
          Result.isFailure(yield* f.apply([changed]).pipe(Effect.result)),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* f
              .apply([yield* record("0000.sql", "SELECT 1;"), first])
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(f.control.migrations).toBe(before);
        expect(f.objects.size).toBe(0);
      }),
    ),
  { timeout: 30_000 },
);

test(
  "failed SQL rolls back its data and marker and retains the uncertain lock",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const outcome = yield* f
          .apply([
            yield* record(
              "0001.sql",
              "CREATE TABLE rolled_back(x); INSERT INTO missing VALUES (1);",
            ),
          ])
          .pipe(Effect.result);
        expect(Result.isFailure(outcome)).toBe(true);
        yield* Effect.sync(() => {
          expect(
            f.db
              .query(
                "SELECT name FROM sqlite_master WHERE name = 'rolled_back'",
              )
              .all(),
          ).toEqual([]);
          expect(
            f.db.query("SELECT * FROM __alchemy_migrations").all(),
          ).toEqual([]);
        });
        expect(f.objects.has(migrationLockKey("database"))).toBe(true);
      }),
    ),
  { timeout: 30_000 },
);

test(
  "lost committed responses recover by reading receipts without replay",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.control.loseResponse = true;
        yield* f.apply([
          yield* record(
            "0001.sql",
            "CREATE TABLE t(x); INSERT INTO t VALUES (1);",
          ),
        ]);
        expect(f.control.migrations).toBe(2);
        expect(f.objects.size).toBe(0);
        yield* Effect.sync(() =>
          expect(f.db.query("SELECT * FROM t").all()).toEqual([{ x: 1 }]),
        );
      }),
    ),
  { timeout: 30_000 },
);

test(
  "conditional lock excludes a concurrent executor before it reads the ledger",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.control.beforeMigrate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const records = [yield* record("0001.sql", "CREATE TABLE t(x);")];
        const first = yield* f.apply(records).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const reads = f.control.queries;
        expect(
          Result.isFailure(yield* f.apply(records).pipe(Effect.result)),
        ).toBe(true);
        expect(f.control.queries).toBe(reads);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        expect(f.objects.size).toBe(0);
      }),
    ),
  { timeout: 30_000 },
);

test(
  "foreign wrangler history converts once and remains frozen",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* record("0001.sql", "CREATE TABLE existing(x);");
        yield* Effect.sync(() => {
          f.db.exec(
            "CREATE TABLE existing(x); CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO d1_migrations VALUES (1, '0001.sql', '2026-01-01');",
          );
        });
        yield* f.apply([
          first,
          yield* record("0002.sql", "INSERT INTO existing VALUES (7);"),
        ]);
        yield* Effect.sync(() => {
          expect(f.db.query("SELECT name FROM d1_migrations").all()).toEqual([
            { name: "0001.sql" },
          ]);
          expect(
            f.db
              .query(
                "SELECT hash FROM __alchemy_migrations WHERE name = '0001.sql'",
              )
              .get(),
          ).toEqual({ hash: first.hash });
          expect(f.db.query("SELECT * FROM existing").all()).toEqual([
            { x: 7 },
          ]);
        });
      }),
    ),
  { timeout: 30_000 },
);

test(
  "transactional registry preconditions reject a writer racing the ledger read",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* record("0001.sql", "CREATE TABLE t(x);");
        yield* f.apply([first]);
        f.control.beforeMigrate = Effect.sync(() => {
          f.db.exec("PRAGMA ignore_check_constraints = ON;");
          f.db.exec("UPDATE __alchemy_migrations SET hash = 'foreign'");
        });
        const outcome = yield* f
          .apply([
            first,
            yield* record("0002.sql", "INSERT INTO t VALUES (1);"),
          ])
          .pipe(Effect.result);
        expect(Result.isFailure(outcome)).toBe(true);
        yield* Effect.sync(() =>
          expect(f.db.query("SELECT * FROM t").all()).toEqual([]),
        );
      }),
    ),
  { timeout: 30_000 },
);

test(
  "failed introspection never becomes permission to create or migrate",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.control.failReads = true;
        expect(
          Result.isFailure(
            yield* f
              .apply([yield* record("0001.sql", "CREATE TABLE t(x);")])
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(f.control.migrations).toBe(0);
        expect(f.objects.size).toBe(0);
      }),
    ),
  { timeout: 30_000 },
);
