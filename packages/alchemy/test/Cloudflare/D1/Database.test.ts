import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { destroy, test } from "@/Test/Vitest";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "create and delete database with default props",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("DefaultDatabase");
      }),
    );

    expect(database.databaseName).toBeDefined();
    expect(database.databaseId).toBeDefined();

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    yield* destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete database",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("TestDatabase", {
          readReplication: { mode: "disabled" },
        });
      }),
    );

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    const updatedDatabase = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("TestDatabase", {
          readReplication: { mode: "auto" },
        });
      }),
    );

    expect(updatedDatabase.databaseId).toEqual(database.databaseId);

    const actualUpdatedDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: updatedDatabase.databaseId,
    });
    expect(actualUpdatedDatabase.readReplication?.mode).toEqual("auto");

    yield* destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "applies migrations from migrationsDir",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-migrations-",
    });

    yield* fs.writeFileString(
      path.join(migrationsDir, "0001_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    );
    yield* fs.writeFileString(
      path.join(migrationsDir, "0002_posts.sql"),
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
    );

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("MigrationDatabase", {
          migrationsDir,
        });
      }),
    );

    expect(database.migrationsDir).toEqual(migrationsDir);
    expect(database.migrationsTable).toEqual("d1_migrations");
    expect(Object.keys(database.migrationsHashes).sort()).toEqual([
      "0001_users.sql",
      "0002_posts.sql",
    ]);

    const tables = yield* listTables(accountId, database.databaseId);
    expect(tables).toContain("users");
    expect(tables).toContain("posts");
    expect(tables).toContain("d1_migrations");

    const applied = yield* queryAll<{ id: string; name: string }>(
      accountId,
      database.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    expect(applied).toEqual([
      { id: "00001", name: "0001_users.sql" },
      { id: "00002", name: "0002_posts.sql" },
    ]);
    for (const row of applied) {
      expect(row.id).toMatch(/^\d{5}$/);
    }

    // Adding a new migration on update should apply only the new one and the
    // sequential id should continue from where it left off.
    yield* fs.writeFileString(
      path.join(migrationsDir, "0003_comments.sql"),
      "CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
    );

    const updated = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("MigrationDatabase", {
          migrationsDir,
        });
      }),
    );
    expect(updated.databaseId).toEqual(database.databaseId);

    const tablesAfter = yield* listTables(accountId, database.databaseId);
    expect(tablesAfter).toContain("comments");

    const appliedAfter = yield* queryAll<{ id: string; name: string }>(
      accountId,
      database.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    expect(appliedAfter).toEqual([
      { id: "00001", name: "0001_users.sql" },
      { id: "00002", name: "0002_posts.sql" },
      { id: "00003", name: "0003_comments.sql" },
    ]);

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "applies migrations using a custom migrationsTable",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-custom-migrations-",
    });
    yield* fs.writeFileString(
      path.join(migrationsDir, "0001_create.sql"),
      "CREATE TABLE test_migrations_table (id INTEGER PRIMARY KEY, name TEXT);",
    );

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("CustomMigrationsTableDb", {
          migrationsDir,
          migrationsTable: "custom_migration_tracking",
        });
      }),
    );

    expect(database.migrationsTable).toEqual("custom_migration_tracking");

    const tables = yield* listTables(accountId, database.databaseId);
    expect(tables).toContain("custom_migration_tracking");
    expect(tables).toContain("test_migrations_table");
    // The default table must NOT be created when a custom one is configured.
    expect(tables).not.toContain("d1_migrations");

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "migrates legacy 2-column migration table to wrangler schema",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-legacy-",
    });
    yield* fs.writeFileString(
      path.join(migrationsDir, "0002_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    );
    yield* fs.writeFileString(
      path.join(migrationsDir, "0003_create_posts.sql"),
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
    );

    yield* destroy();

    // Step 1: deploy the database without migrations so we can seed a legacy
    // 2-column d1_migrations table on it before re-deploying with a
    // migrationsDir.
    const seeded = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("LegacyMigrationDb");
      }),
    );

    yield* execSql(
      accountId,
      seeded.databaseId,
      `CREATE TABLE d1_migrations (
         id TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       );`,
    );
    yield* execSql(
      accountId,
      seeded.databaseId,
      `INSERT INTO d1_migrations (id, applied_at) VALUES
         ('0000_initial_setup.sql', datetime('now', '-1 day')),
         ('0001_add_indexes.sql', datetime('now', '-1 hour'));`,
    );

    // Step 2: deploy again with a migrationsDir; the resource should detect
    // the legacy 2-column schema, migrate to (id, name, applied_at), and apply
    // the new migrations on top.
    const upgraded = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("LegacyMigrationDb", {
          migrationsDir,
        });
      }),
    );
    expect(upgraded.databaseId).toEqual(seeded.databaseId);

    const columns = yield* queryAll<{ name: string }>(
      accountId,
      seeded.databaseId,
      "PRAGMA table_info(d1_migrations);",
    );
    const colNames = columns.map((c) => c.name).sort();
    expect(colNames).toEqual(["applied_at", "id", "name"]);

    const records = yield* queryAll<{ id: string; name: string }>(
      accountId,
      seeded.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    const names = records.map((r) => r.name);
    expect(names).toContain("0000_initial_setup.sql");
    expect(names).toContain("0001_add_indexes.sql");
    expect(names).toContain("0002_create_users.sql");
    expect(names).toContain("0003_create_posts.sql");

    // All ids should be 5-digit zero-padded sequential numbers.
    for (const r of records) {
      expect(r.id).toMatch(/^\d{5}$/);
    }
    expect(records[0].id).toBe("00001");
    expect(records[records.length - 1].id).toBe(
      records.length.toString().padStart(5, "0"),
    );

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(seeded.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "imports SQL files via importFiles",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-imports-",
    });
    const importPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      importPath,
      [
        "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
        "INSERT INTO widgets (id, label) VALUES (1, 'one');",
        "INSERT INTO widgets (id, label) VALUES (2, 'two');",
      ].join("\n"),
    );

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("ImportDatabase", {
          importFiles: [importPath],
        });
      }),
    );

    expect(database.importHashes[importPath]).toBeDefined();

    const widgets = yield* getResults<{ id: number; label: string }>(
      accountId,
      database.databaseId,
      "SELECT id, label FROM widgets ORDER BY id;",
    );
    expect(widgets).toEqual([
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ]);

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "clones a database by databaseId",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-id-",
    });
    const seedPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      seedPath,
      [
        "CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        "INSERT INTO colors (id, name) VALUES (1, 'red'), (2, 'green'), (3, 'blue');",
      ].join("\n"),
    );

    yield* destroy();

    const { source, target } = yield* test.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1Database("CloneByIdSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1Database("CloneByIdTarget", {
          clone: { databaseId: source.databaseId },
        });
        return { source, target };
      }),
    );

    expect(target.databaseId).not.toEqual(source.databaseId);

    const targetColors = yield* getResults<{ id: number; name: string }>(
      accountId,
      target.databaseId,
      "SELECT id, name FROM colors ORDER BY id;",
    );
    expect(targetColors).toEqual([
      { id: 1, name: "red" },
      { id: 2, name: "green" },
      { id: 3, name: "blue" },
    ]);

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "clones a database by name lookup",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-name-",
    });
    const seedPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      seedPath,
      [
        "CREATE TABLE animals (id INTEGER PRIMARY KEY, kind TEXT NOT NULL);",
        "INSERT INTO animals (id, kind) VALUES (1, 'cat'), (2, 'dog');",
      ].join("\n"),
    );

    yield* destroy();

    const { source, target } = yield* test.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1Database("CloneByNameSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1Database("CloneByNameTarget", {
          clone: { name: source.databaseName },
        });
        return { source, target };
      }),
    );

    expect(target.databaseId).not.toEqual(source.databaseId);

    const animals = yield* getResults<{ id: number; kind: string }>(
      accountId,
      target.databaseId,
      "SELECT id, kind FROM animals ORDER BY id;",
    );
    expect(animals).toEqual([
      { id: 1, kind: "cat" },
      { id: 2, kind: "dog" },
    ]);

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "clones a database by passing the source resource directly",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-direct-",
    });
    const seedPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      seedPath,
      [
        "CREATE TABLE shapes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        "INSERT INTO shapes (id, name) VALUES (1, 'square'), (2, 'circle');",
      ].join("\n"),
    );

    yield* destroy();

    const { source, target } = yield* test.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1Database("CloneDirectSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1Database("CloneDirectTarget", {
          clone: source,
        });
        return { source, target };
      }),
    );

    expect(target.databaseId).not.toEqual(source.databaseId);

    const shapes = yield* getResults<{ id: number; name: string }>(
      accountId,
      target.databaseId,
      "SELECT id, name FROM shapes ORDER BY id;",
    );
    expect(shapes).toEqual([
      { id: 1, name: "square" },
      { id: 2, name: "circle" },
    ]);

    yield* destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const queryAll = Effect.fn(function* <T>(
  accountId: string,
  databaseId: string,
  sql: string,
) {
  const queryDb = yield* d1.queryDatabase;
  const result = yield* queryDb({ accountId, databaseId, sql });
  return (result.result[0]?.results ?? []) as T[];
});

const execSql = (accountId: string, databaseId: string, sql: string) =>
  queryAll<unknown>(accountId, databaseId, sql);

const listTables = Effect.fn(function* (accountId: string, databaseId: string) {
  const rows = yield* queryAll<{ name: string }>(
    accountId,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type='table';",
  );
  return rows.map((r) => r.name);
});

/**
 * D1 query results are eventually consistent following an import/clone, so
 * retry until we see at least one row (matches v1's `getResults` helper).
 */
const getResults = Effect.fn(function* <T>(
  accountId: string,
  databaseId: string,
  sql: string,
) {
  return yield* queryAll<T>(accountId, databaseId, sql).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.succeed(rows)
        : Effect.fail(new EmptyResults({ sql })),
    ),
    Effect.retry({
      while: (e) => e instanceof EmptyResults,
      schedule: Schedule.both(
        Schedule.spaced(Duration.seconds(1)),
        Schedule.recurs(10),
      ),
    }),
    Effect.orDie,
  );
});

const waitForDatabaseToBeDeleted = Effect.fn(function* (
  databaseId: string,
  accountId: string,
) {
  yield* d1
    .getDatabase({
      accountId,
      databaseId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("DatabaseNotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
class EmptyResults extends Data.TaggedError("EmptyResults")<{
  sql: string;
}> {}
