import { Database } from "bun:sqlite";
import {
  applyAlchemyFormat,
  applyMigrations,
  MigrationError,
  readDrizzleDirRecords,
  readFlatRecords,
  type SqlExecutor,
} from "@alchemy.run/sql/Migrations";
import { applyPendingAlchemyFormat } from "@alchemy.run/sql/Migrations/AlchemyFormat";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { makeSqliteExecutor, tableNames } from "./sqlite-executor.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

const describe = layer(NodeServices.layer);

/** A drizzle-kit v1 directory: one `<name>/migration.sql` per entry. */
const writeMigrationDirs = (folders: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-mig-up-" });
    for (const [name, sql] of Object.entries(folders)) {
      yield* fs.makeDirectory(path.join(dir, name));
      yield* fs.writeFileString(path.join(dir, name, "migration.sql"), sql);
    }
    return dir;
  });

const ALCHEMY_COLUMNS = ["id", "hash", "created_at", "name", "applied_at"];

const migrationRows = (db: Database, table = "__alchemy_migrations") =>
  db.query(`SELECT hash, created_at, name, applied_at FROM ${table} ORDER BY id;`).all() as Array<{
    hash: string;
    created_at: number | null;
    name: string;
    applied_at: string | null;
  }>;

// Fails `0001_users.sql` batches the way a data API can (#1889): `"lost"` runs
// the batch and then fails the reply, `"dropped"` fails before running it.
// `transient` is the flag the transport sets on the failure, `failures` is how
// many sends fail, and `failLedgerRead` fails the ledger read that follows a
// failed send.
const flakyBatches = (
  executor: SqlExecutor,
  options: {
    fault: "lost" | "dropped";
    transient: boolean;
    failures?: number;
    failLedgerRead?: boolean;
  },
): SqlExecutor & { sends: () => number } => {
  const { fault, transient, failures = 1, failLedgerRead = false } = options;
  let sends = 0;
  let failed = false;
  return {
    ...executor,
    sends: () => sends,
    query: (sql, params) =>
      failed && failLedgerRead
        ? Effect.fail(new MigrationError({ message: "ledger read failed", transient: true }))
        : executor.query(sql, params),
    batch: (statements) =>
      Effect.gen(function* () {
        // Only the migration's own batch, not the bookkeeping table's setup.
        if (!statements.some((statement) => statement.includes("CREATE TABLE users"))) {
          return yield* executor.batch(statements);
        }
        sends++;
        if (sends > failures) return yield* executor.batch(statements);
        if (fault === "lost") yield* executor.batch(statements);
        failed = true;
        return yield* new MigrationError({ message: "503 Service Unavailable", transient });
      }),
  };
};

describe("alchemy format", (it) => {
  it.effect(
    "does not resend a batch that landed before its reply was lost",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), { fault: "lost", transient: true });
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        // A resend would fail on the bare CREATE TABLE.
        expect(executor.sends()).toBe(1);
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "resends a transient batch failure that did not land",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: true,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        expect(executor.sends()).toBe(2);
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails when the resend fails too, without sending a third time",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: true,
          failures: 2,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(0, 1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationError");
          expect(result.failure.message).toContain("503");
        }
        expect(executor.sends()).toBe(2);
        expect(migrationRows(db)).toEqual([]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails without resending when the ledger cannot be read after a failure",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: true,
          failLedgerRead: true,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(0, 1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationError");
          expect(result.failure.message).toContain("ledger read failed");
        }
        expect(executor.sends()).toBe(1);
        expect(migrationRows(db)).toEqual([]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails a non-transient batch failure without resending it",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: false,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(0, 1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("MigrationError");
        expect(executor.sends()).toBe(1);
        expect(migrationRows(db)).toEqual([]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "creates the table and applies flat migrations in order",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        expect(tableNames(db)).toEqual(
          expect.arrayContaining(["__alchemy_migrations", "posts", "users"]),
        );
        const columns = db.query("PRAGMA table_info(__alchemy_migrations);").all() as Array<{
          name: string;
        }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);

        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0].applied_at).toBeTruthy();

        // Idempotent — a replay would throw on the bare CREATE TABLEs.
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).length).toBe(2);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "applies only pending migrations on subsequent runs",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  // #1389: name-keyed skip used to ignore content hashes, then the
  // resource persisted the new hashes as if the rewrite had applied.
  it.effect(
    "fails when an already-applied migration's contents changed",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });
        const rewritten = [
          {
            ...records[0],
            hash: "a".repeat(64),
            sql: "SELECT 1;",
            statements: ["SELECT 1;"],
          },
          records[1],
        ];
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: rewritten,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("RewrittenMigrationHistoryError");
          expect(result.failure.message).toContain("0001_users.sql");
        }
        expect(migrationRows(db).map((r) => r.hash)).toEqual(records.map((r) => r.hash));
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails when an already-applied migration file is removed",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("RewrittenMigrationHistoryError");
          expect(result.failure.message).toContain("0001_users.sql");
        }
      }),
    { tags: ["unit", "local"] },
  );

  // #2912: a file that sorts before an applied one would run in a different
  // order here than on every fresh database.
  it.effect(
    "fails when a pending migration sorts before an applied one",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: [posts],
        });
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: [users, posts],
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("NonLinearMigrationHistoryError");
          expect(result.failure.message).toContain("0001_users.sql");
          expect(result.failure.message).toContain("0002_posts.sql");
        }
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "applies an out-of-order migration once it is renamed to sort last",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: [posts],
        });
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: [posts, { ...users, name: "0003_users.sql" }],
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0002_posts.sql", "0003_users.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  // Renaming is how an out-of-order file is fixed, and a database that
  // already ran the file under its old name must not fail or run it again.
  it.effect(
    "keeps an applied migration applied when its file is renamed",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        // Re-running 0001 would fail: its table already exists.
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: [posts, { ...users, name: "0003_users.sql" }],
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0003_users.sql", "0002_posts.sql"]);
        expect(migrationRows(db).map((r) => r.hash)).toEqual([users.hash, posts.hash]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "keeps a renamed migration applied on the runtime apply path",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyPendingAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        yield* applyPendingAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: [{ ...users, name: "0000_users.sql" }, posts],
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0000_users.sql", "0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "pairs each applied row with at most one renamed file",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records: [users] });
        // Both files carry 0001's hash; only the first takes its row, the
        // other is new and runs.
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: [
            { ...users, name: "0003_users.sql" },
            { ...posts, name: "0004_posts.sql", hash: users.hash },
          ],
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0003_users.sql", "0004_posts.sql"]);
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
  );

  // A database that ran the file under its old name, but not a file that
  // now sorts before its new name, ran them out of order.
  it.effect(
    "fails when a renamed migration now sorts after one this database never ran",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records: [users] });
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: [posts, { ...users, name: "0003_users.sql" }],
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("NonLinearMigrationHistoryError");
        }
        expect(tableNames(db)).not.toContain("posts");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails when a renamed migration's contents also changed",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const [users, posts] = records;
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: [posts, { ...users, name: "0003_users.sql", hash: "a".repeat(64) }],
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("RewrittenMigrationHistoryError");
        }
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "upgrades the legacy Alchemy 3-column table in place without replaying",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // A pre-registry deploy: the invented shape, TEXT id.
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '0001_users.sql', '2024-01-01 00:00:00');",
        );
        // ...and migration 0001 really ran:
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        // Legacy deploys keep converging against their persisted table.
        yield* applyAlchemyFormat({ executor, table: "d1_migrations", records });

        const columns = db.query("PRAGMA table_info(d1_migrations);").all() as Array<{
          name: string;
          type: string;
        }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);
        const rows = migrationRows(db, "d1_migrations");
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        // Backfilled from the matching local record, not a placeholder.
        expect(rows[0].hash).toBe(records[0].hash);
        // The original applied_at survives the rebuild.
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "upgrades the oldest 2-column shape, reading names from the primary column",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE __alchemy_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO __alchemy_migrations (id, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "converts a wrangler-shaped table in place when it IS the resolved table",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "d1_migrations", records });
        const columns = db.query("PRAGMA table_info(d1_migrations);").all() as Array<{
          name: string;
        }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);
        expect(migrationRows(db, "d1_migrations").map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "legacy rows recorded as dir/migration.sql keep matching directory records",
    () =>
      // Pre-registry Alchemy applied drizzle-layout dirs under the flat
      // key (`<dir>/migration.sql`); current records key them by `<dir>`.
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '20240101000000_init/migration.sql', '2024-01-01 00:00:00');",
        );
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        yield* applyAlchemyFormat({ executor, table: "d1_migrations", records });
        expect(migrationRows(db, "d1_migrations").map((r) => r.name)).toEqual([
          "20240101000000_init/migration.sql",
          "20240102000000_add_posts",
        ]);
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails the upgrade when a recorded migration matches no local file",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE __alchemy_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO __alchemy_migrations (id, name, applied_at) VALUES ('00001', 'zzz_deleted.sql', '2024-01-01 00:00:00');",
        );
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
          expect(result.failure.message).toContain("zzz_deleted.sql");
        }
      }),
    { tags: ["unit", "local"] },
  );
});

describe("one-way conversion from foreign tables", (it) => {
  it.effect(
    "adopts a wrangler-migrated database: history copied, table frozen",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // What `wrangler d1 migrations apply` left behind.
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        // History converted, only the pending migration ran.
        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        expect(rows[0].hash).toBe(records[0].hash);
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");

        // The wrangler table is frozen — never written, never dropped.
        const wrangler = db.query("SELECT name FROM d1_migrations ORDER BY id;").all() as Array<{
          name: string;
        }>;
        expect(wrangler.map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  // `drizzle-kit up` turns `0000_init.sql` into `<when>_init/migration.sql`
  // (drizzle-kit `planFoldersV3`), byte for byte; wrangler's rows keep the
  // old names.
  it.effect(
    "wrangler history follows drizzle-kit up's rename",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_init.sql', '2024-01-01 00:00:00'), ('0001_add_posts.sql', '2024-01-02 00:00:00');",
        );
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");
        db.run(
          "CREATE TABLE posts (id integer PRIMARY KEY NOT NULL, user_id integer NOT NULL, title text NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        // Re-running either file would fail: its table exists.
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
        expect(rows.map((r) => r.hash)).toEqual(records.map((r) => r.hash));
        expect(rows.map((r) => r.applied_at)).toEqual([
          "2024-01-01 00:00:00",
          "2024-01-02 00:00:00",
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "wrangler rows sharing a name after drizzle-kit up pair in order",
    () =>
      Effect.gen(function* () {
        const dir = yield* writeMigrationDirs({
          "20240101000000_add": "CREATE TABLE a (id INTEGER);",
          "20240102000000_add": "CREATE TABLE b (id INTEGER);",
        });
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run("INSERT INTO d1_migrations (name) VALUES ('0000_add.sql'), ('0001_add.sql');");
        db.run("CREATE TABLE a (id INTEGER);");
        db.run("CREATE TABLE b (id INTEGER);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(dir);
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        const rows = migrationRows(db);
        expect(rows.map((r) => [r.name, r.hash])).toEqual(records.map((r) => [r.name, r.hash]));
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a renamed file never pairs a wrangler row with another migration's record",
    () =>
      Effect.gen(function* () {
        // `0001_foo.sql` was renamed `0001_bar.sql` before wrangler applied it;
        // `0002_bar` was never applied. Pairing by name alone would record
        // `<ts>_bar` as applied, and it never ran.
        const dir = yield* writeMigrationDirs({
          "20240101000000_init": "CREATE TABLE init (id INTEGER);",
          "20240102000000_foo": "CREATE TABLE foo (id INTEGER);",
          "20240105000000_bar": "CREATE TABLE bar (id INTEGER);",
        });
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run("INSERT INTO d1_migrations (name) VALUES ('0000_init.sql'), ('0001_bar.sql');");
        db.run("CREATE TABLE init (id INTEGER);");
        db.run("CREATE TABLE foo (id INTEGER);");
        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(dir);
        const result = yield* Effect.result(
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
        }
        // Nothing was recorded.
        expect(tableNames(db)).not.toContain("__alchemy_migrations");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a pending migration sharing an applied one's name stays pending after drizzle-kit up",
    () =>
      Effect.gen(function* () {
        const dir = yield* writeMigrationDirs({
          "20240101000000_add": "CREATE TABLE a (id INTEGER);",
          "20240105000000_add": "CREATE TABLE b (id INTEGER);",
        });
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run("INSERT INTO d1_migrations (name) VALUES ('0000_add.sql');");
        db.run("CREATE TABLE a (id INTEGER);");
        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(dir);
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).map((r) => r.name)).toEqual([
          "20240101000000_add",
          "20240105000000_add",
        ]);
        expect(tableNames(db)).toContain("b");
      }),
    { tags: ["unit", "local"] },
  );

  // Pre-registry Alchemy's d1_migrations recorded file names, as wrangler does.
  it.effect(
    "legacy Alchemy history follows drizzle-kit up's rename, as a source and in place",
    () =>
      Effect.gen(function* () {
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        for (const table of ["__alchemy_migrations", "d1_migrations"]) {
          const db = new Database(":memory:");
          db.run(
            "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
          );
          db.run(
            "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '0000_init.sql', '2024-01-01 00:00:00');",
          );
          db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
          db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");
          const executor = makeSqliteExecutor(db);
          yield* applyAlchemyFormat({ executor, table, records });
          expect(migrationRows(db, table).map((r) => r.name)).toEqual([
            "20240101000000_init",
            "20240102000000_add_posts",
          ]);
        }
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a wrangler row drizzle-kit up's rename can't name is a conflict, never a guess",
    () =>
      Effect.gen(function* () {
        for (const [rows, folders] of [
          // The file was renamed away from its journal tag before `drizzle-kit up`.
          [["0000_users.sql"], { "20240101000000_init": "CREATE TABLE users (id INTEGER);" }],
          // Two rows share a name one folder has.
          [
            ["0000_add.sql", "0001_add.sql"],
            { "20240101000000_add": "CREATE TABLE a (id INTEGER);" },
          ],
        ] as const) {
          const dir = yield* writeMigrationDirs(folders);
          const db = new Database(":memory:");
          db.run(
            "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
          );
          for (const name of rows) db.run(`INSERT INTO d1_migrations (name) VALUES ('${name}');`);
          const executor = makeSqliteExecutor(db);
          const records = yield* readDrizzleDirRecords(dir);
          const result = yield* Effect.result(
            applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("MigrationHistoryConflictError");
            expect(result.failure.message).toContain(rows[rows.length - 1]!);
          }
        }
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "conversion fails when foreign history references a missing local file",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run("INSERT INTO d1_migrations (name) VALUES ('zzz_gone.sql');");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
        }
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "adopts a state-lost legacy 3-column d1_migrations as a conversion source",
    () =>
      // Old Alchemy deploys wrote a 3-column d1_migrations; if state was
      // lost (adoption), the resolved table is __alchemy_migrations and
      // the legacy table must be picked up as a source, not replayed.
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        expect(rows[0].hash).toBe(records[0].hash);
        // The legacy table is frozen as a source, still 3 columns.
        const legacyColumns = db.query("PRAGMA table_info(d1_migrations);").all() as Array<{
          name: string;
        }>;
        expect(legacyColumns.map((c) => c.name)).toEqual(["id", "name", "applied_at"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "converts drizzle-orm 0.x history, which has no name column, as drizzle-orm 1.0 upgrades it",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        // `drizzle-kit up` converts the migrations folder and leaves the database:
        // a database drizzle-orm 0.x migrated keeps its original table, whose
        // `created_at` is the journal's `when` in milliseconds.
        db.run(
          "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);",
        );
        db.run(
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${records[0].hash}', 1704067200417);`,
        );
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        const rows = migrationRows(db);
        // The applied migration converts instead of running again; the next applies.
        expect(rows.map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
        expect(rows[0].hash).toBe(records[0].hash);
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "converts drizzle-orm 0.x history in place when it is the resolved table",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        db.run(
          "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);",
        );
        db.run(
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${records[0].hash}', 1704067200417);`,
        );
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        yield* applyAlchemyFormat({ executor, table: "__drizzle_migrations", records });
        const rows = migrationRows(db, "__drizzle_migrations");
        expect(rows.map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a drizzle-orm 0.x row whose second two migrations share is named by its hash",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // `drizzle-kit up` names folders to the second, so two migrations made
        // in the same second share a timestamp; drizzle-orm 1.0 then matches by hash.
        const record = (name: string, sql: string) => ({
          name,
          hash: new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
          createdAtMillis: 1704067200000,
          sql,
          statements: [sql],
        });
        const records = [
          record("20240101000000_a", "CREATE TABLE a (id integer);"),
          record("20240101000000_b", "CREATE TABLE b (id integer);"),
        ];
        db.run(
          "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);",
        );
        // Recorded `b` first: taking the first candidate would name both rows `a`.
        db.run(
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${records[1].hash}', 1704067200417), ('${records[0].hash}', 1704067200950);`,
        );
        db.run("CREATE TABLE a (id integer);");
        db.run("CREATE TABLE b (id integer);");

        const executor = makeSqliteExecutor(db);
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        // Each row converts under the migration its hash names; nothing runs again.
        expect(migrationRows(db).map((r) => [r.name, r.hash])).toEqual([
          ["20240101000000_b", records[1].hash],
          ["20240101000000_a", records[0].hash],
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a table with a hash but no created_at is an unrecognized layout, not drizzle-orm 0.x",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        db.run("CREATE TABLE migrations (id INTEGER PRIMARY KEY, hash text NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const result = yield* Effect.result(
          applyAlchemyFormat({ executor, table: "migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("unrecognized column layout");
        }
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a drizzle-orm 0.x row that matches no local migration stops the conversion",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        db.run(
          "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);",
        );
        db.run(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('not-a-local-hash', 1600000000000);",
        );

        const executor = makeSqliteExecutor(db);
        const result = yield* Effect.result(
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
          expect(result.failure.message).toContain("[id: 1, created_at: 1600000000000]");
        }
        expect(tableNames(db)).not.toContain("users");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "prefers drizzle history when multiple foreign sources exist",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        // Both a drizzle table and a wrangler table exist; drizzle's is
        // probed first and carries hashes, so it wins.
        db.run(
          "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT);",
        );
        db.run(
          `INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('${records[0].hash}', 1704067200000, '20240101000000_init');`,
        );
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run("INSERT INTO d1_migrations (name) VALUES ('20240101000000_init');");
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
        // Hash came from drizzle's table (wrangler has none).
        expect(rows[0].hash).toBe(records[0].hash);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "adopts a prisma-migrated database via _prisma_migrations",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // Prisma's table shape (sqlite rendition), one applied + one
        // rolled-back migration.
        db.run(
          `CREATE TABLE _prisma_migrations (
           id TEXT PRIMARY KEY,
           checksum TEXT NOT NULL,
           finished_at TEXT,
           migration_name TEXT NOT NULL,
           logs TEXT,
           rolled_back_at TEXT,
           started_at TEXT NOT NULL,
           applied_steps_count INTEGER NOT NULL DEFAULT 0
         );`,
        );
        const records = yield* readDrizzleDirRecords(fixture("prisma"));
        db.run(
          `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
         VALUES ('a', '${records[0].hash}', '2024-01-01 00:00:01', '20240101000000_init', '2024-01-01 00:00:00', 1);`,
        );
        db.run(
          `INSERT INTO _prisma_migrations (id, checksum, rolled_back_at, migration_name, started_at)
         VALUES ('b', 'dead', '2024-01-02 00:00:00', '20240102000000_rolled_back', '2024-01-02 00:00:00');`,
        );
        // The applied migration's tables exist (Prisma-dialect SQL in the
        // fixture is postgres-flavored, so create a stand-in):
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");

        const executor = makeSqliteExecutor(db);
        yield* applyAlchemyFormat({
          executor,
          // Only the applied row must convert; the rolled-back row is
          // skipped even though it has no local file.
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["20240101000000_init"]);
        // Prisma's checksum is sha256 of migration.sql — carried verbatim.
        expect(rows[0].hash).toBe(records[0].hash);
        // Frozen source.
        expect(
          (
            db.query("SELECT COUNT(*) AS n FROM _prisma_migrations;").all() as Array<{ n: number }>
          )[0].n,
        ).toBe(2);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a failed prisma migration blocks conversion with guidance",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          `CREATE TABLE _prisma_migrations (
           id TEXT PRIMARY KEY,
           checksum TEXT NOT NULL,
           finished_at TEXT,
           migration_name TEXT NOT NULL,
           logs TEXT,
           rolled_back_at TEXT,
           started_at TEXT NOT NULL,
           applied_steps_count INTEGER NOT NULL DEFAULT 0
         );`,
        );
        db.run(
          `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at)
         VALUES ('a', 'abc', '20240101000000_broken', '2024-01-01 00:00:00');`,
        );
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationError");
          expect(result.failure.message).toContain("prisma migrate resolve");
        }
      }),
    { tags: ["unit", "local"] },
  );
});

describe("registry apply", (it) => {
  it.effect(
    "keys directory-layout dirs by directory name",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        yield* applyMigrations({
          resolved: { dir: fixture("drizzle-v1"), table: "__alchemy_migrations" },
          executor,
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "rejects drizzle-v0 layouts",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const result = yield* Effect.result(
          applyMigrations({
            resolved: { dir: fixture("drizzle-v0"), table: "__alchemy_migrations" },
            executor,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("DrizzleV0LayoutError");
        }
      }),
    { tags: ["unit", "local"] },
  );
});
