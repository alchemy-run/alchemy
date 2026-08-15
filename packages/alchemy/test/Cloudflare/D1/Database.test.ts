import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { hashMigrations } from "@/SQL/SqlFile.ts";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete database with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("DefaultDatabase");
      }),
    );

    expect(database.databaseName).toBeDefined();
    expect(database.databaseId).toBeDefined();

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    yield* stack.destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete database", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("TestDatabase", {
          readReplication: { mode: "disabled" },
        });
      }),
    );

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    const updatedDatabase = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("TestDatabase", {
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

    yield* stack.destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("applies migrations from migrationsDir", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
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

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("MigrationDatabase", {
          migrationsDir,
        });
      }),
    );

    expect(database.migrationsDir).toEqual(migrationsDir);
    expect(database.migrationsTable).toEqual("d1_migrations");
    // Flat .sql dirs use wrangler's real table format, so the wrangler CLI
    // can list/apply against an Alchemy-managed database.
    expect(database.migrationsFormat).toEqual("wrangler");
    expect(Object.keys(database.migrationsHashes).sort()).toEqual([
      "0001_users.sql",
      "0002_posts.sql",
    ]);

    const tables = yield* listTables(accountId, database.databaseId);
    expect(tables).toContain("users");
    expect(tables).toContain("posts");
    expect(tables).toContain("d1_migrations");

    // wrangler's shape: INTEGER AUTOINCREMENT ids, name-keyed.
    const applied = yield* queryAll<{ id: number; name: string }>(
      accountId,
      database.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    expect(applied).toEqual([
      { id: 1, name: "0001_users.sql" },
      { id: 2, name: "0002_posts.sql" },
    ]);

    // Adding a new migration on update should apply only the new one and the
    // sequential id should continue from where it left off.
    yield* fs.writeFileString(
      path.join(migrationsDir, "0003_comments.sql"),
      "CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("MigrationDatabase", {
          migrationsDir,
        });
      }),
    );
    expect(updated.databaseId).toEqual(database.databaseId);

    const tablesAfter = yield* listTables(accountId, database.databaseId);
    expect(tablesAfter).toContain("comments");

    const appliedAfter = yield* queryAll<{ id: number; name: string }>(
      accountId,
      database.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    expect(appliedAfter).toEqual([
      { id: 1, name: "0001_users.sql" },
      { id: 2, name: "0002_posts.sql" },
      { id: 3, name: "0003_comments.sql" },
    ]);

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("applies migrations using a custom migrationsTable", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-custom-migrations-",
    });
    yield* fs.writeFileString(
      path.join(migrationsDir, "0001_create.sql"),
      "CREATE TABLE test_migrations_table (id INTEGER PRIMARY KEY, name TEXT);",
    );

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("CustomMigrationsTableDb", {
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

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider(
  "applies drizzle-kit layout migrations via drizzle's own bookkeeping",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-drizzle-",
      });
      yield* fs.makeDirectory(path.join(migrationsDir, "20240101000000_init"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101000000_init", "migration.sql"),
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);\n--> statement-breakpoint\nCREATE UNIQUE INDEX users_name_unique ON users (name);",
      );

      yield* stack.destroy();

      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("DrizzleMigrationDb", {
            migrations: migrationsDir,
          });
        }),
      );

      // Layout detection: drizzle dirs delegate to drizzle-orm's migrator.
      expect(database.migrationsFormat).toEqual("drizzle");
      expect(database.migrationsTable).toEqual("__drizzle_migrations");

      const tables = yield* listTables(accountId, database.databaseId);
      expect(tables).toContain("users");
      expect(tables).toContain("__drizzle_migrations");
      expect(tables).not.toContain("d1_migrations");

      // drizzle's bookkeeping: name = directory, hash recorded.
      const applied = yield* queryAll<{ name: string; hash: string }>(
        accountId,
        database.databaseId,
        "SELECT name, hash FROM __drizzle_migrations ORDER BY id;",
      );
      expect(applied.map((r) => r.name)).toEqual(["20240101000000_init"]);
      expect(applied[0].hash).toMatch(/^[0-9a-f]{64}$/);

      // A second migration applies incrementally — the first must not
      // replay (its bare CREATE TABLE would fail).
      yield* fs.makeDirectory(path.join(migrationsDir, "20240102000000_posts"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240102000000_posts", "migration.sql"),
        "CREATE TABLE posts (id integer PRIMARY KEY NOT NULL, title text NOT NULL);",
      );
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("DrizzleMigrationDb", {
            migrations: migrationsDir,
          });
        }),
      );
      expect(updated.databaseId).toEqual(database.databaseId);
      const appliedAfter = yield* queryAll<{ name: string }>(
        accountId,
        database.databaseId,
        "SELECT name FROM __drizzle_migrations ORDER BY id;",
      );
      expect(appliedAfter.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_posts",
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
);

/**
 * True roll-forward: state row AND physical table are rewritten to exactly
 * what pre-registry Alchemy persisted (3-column `id TEXT PK` table,
 * `migrationsHashes` + `migrationsTable` in state but NO `migrationsFormat`
 * stamp), then a normal deploy runs on top. Passing requires legacy
 * inference (unstamped history → wrangler, detection skipped), the in-place
 * table upgrade, and no replay (0001/0002's bare CREATE TABLEs would fail).
 */
test.provider(
  "rolls forward from pre-registry state and 3-column table without replaying",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-rollforward-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      yield* stack.destroy();

      // Phase 1: deploy so the database, tables, and state exist.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDb", {
            migrationsDir,
          });
        }),
      );

      // Phase 2: rewrite BOTH artifacts to the pre-registry shape.
      // 2a. The physical table: id TEXT PK with zero-padded ids.
      yield* execSql(
        accountId,
        deployed.databaseId,
        "DROP TABLE d1_migrations;",
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `CREATE TABLE d1_migrations (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );`,
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `INSERT INTO d1_migrations (id, name, applied_at) VALUES
           ('00001', '0001_users.sql', '2024-01-01 00:00:00'),
           ('00002', '0002_posts.sql', '2024-01-01 00:01:00');`,
      );
      // 2b. The state row: strip the format stamp old code never wrote.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const row = yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "RollForwardDb",
        });
        const attr = { ...(row as any).attr };
        delete attr.migrationsFormat;
        yield* state.set({
          stack: stack.name,
          stage: "test",
          fqn: "RollForwardDb",
          value: { ...(row as any), attr },
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: add a migration and redeploy on top of the legacy state.
      yield* fs.writeFileString(
        path.join(migrationsDir, "0003_comments.sql"),
        "CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      );
      const rolled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDb", {
            migrationsDir,
          });
        }),
      );
      expect(rolled.databaseId).toEqual(deployed.databaseId);
      // Legacy inference resolved to wrangler and stamped it.
      expect(rolled.migrationsFormat).toEqual("wrangler");
      expect(rolled.migrationsTable).toEqual("d1_migrations");

      const columns = yield* queryAll<{ name: string; type: string }>(
        accountId,
        deployed.databaseId,
        "PRAGMA table_info(d1_migrations);",
      );
      expect(columns.find((c) => c.name === "id")?.type).toBe("INTEGER");
      const rows = yield* queryAll<{ id: number; name: string }>(
        accountId,
        deployed.databaseId,
        "SELECT id, name FROM d1_migrations ORDER BY id;",
      );
      expect(rows).toEqual([
        { id: 1, name: "0001_users.sql" },
        { id: 2, name: "0002_posts.sql" },
        { id: 3, name: "0003_comments.sql" },
      ]);
      const tables = yield* listTables(accountId, deployed.databaseId);
      expect(tables).toContain("comments");

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(deployed.databaseId, accountId);
    }).pipe(logLevel),
);

/**
 * The Seth-shaped roll-forward: a drizzle-LAYOUT directory whose history
 * was applied by pre-registry Alchemy under flat keys
 * (`<dir>/migration.sql`) in the legacy table. Legacy inference must keep
 * converging against `d1_migrations` — resolving by layout detection here
 * would start a second bookkeeping table (`__drizzle_migrations`) and
 * replay history into a live database.
 */
test.provider(
  "rolls forward legacy state over a drizzle-layout dir without switching tables",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-rollforward-drizzle-",
      });
      yield* fs.makeDirectory(path.join(migrationsDir, "20240101000000_init"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101000000_init", "migration.sql"),
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
      );

      yield* stack.destroy();

      // Phase 1: deploy WITHOUT migrations, then hand-write what old
      // Alchemy left behind: migration 1 really ran, recorded under its
      // flat path key in the legacy 3-column table.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDrizzleDb");
        }),
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `CREATE TABLE d1_migrations (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );`,
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `INSERT INTO d1_migrations (id, name, applied_at) VALUES
           ('00001', '20240101000000_init/migration.sql', '2024-01-01 00:00:00');`,
      );
      // Old-style state: dir + table + hashes, no format stamp.
      const legacyHashes = yield* hashMigrations(migrationsDir);
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const row = yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "RollForwardDrizzleDb",
        });
        const attr = {
          ...(row as any).attr,
          migrationsDir,
          migrationsTable: "d1_migrations",
          migrationsHashes: legacyHashes,
        };
        delete attr.migrationsFormat;
        yield* state.set({
          stack: stack.name,
          stage: "test",
          fqn: "RollForwardDrizzleDb",
          value: { ...(row as any), attr },
        });
      }).pipe(Effect.provide(stack.state));

      // Explicitly requesting the drizzle format against legacy history
      // must fail the plan — not silently start __drizzle_migrations.
      const mismatch = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.D1.Database("RollForwardDrizzleDb", {
              migrations: { dir: migrationsDir, format: "drizzle" },
            });
          }),
        ),
      );
      expect(Result.isFailure(mismatch)).toBe(true);
      if (Result.isFailure(mismatch)) {
        expect(String(mismatch.failure)).toContain(
          "MigrationFormatMismatchError",
        );
      }

      // Phase 2: add a second drizzle-layout migration and redeploy WITH
      // migrations configured.
      yield* fs.makeDirectory(path.join(migrationsDir, "20240102000000_posts"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240102000000_posts", "migration.sql"),
        "CREATE TABLE posts (id integer PRIMARY KEY NOT NULL, title text NOT NULL);",
      );
      const rolled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDrizzleDb", {
            migrations: migrationsDir,
          });
        }),
      );
      expect(rolled.databaseId).toEqual(deployed.databaseId);
      // Legacy history wins over layout detection.
      expect(rolled.migrationsFormat).toEqual("wrangler");
      expect(rolled.migrationsTable).toEqual("d1_migrations");

      const tables = yield* listTables(accountId, deployed.databaseId);
      expect(tables).not.toContain("__drizzle_migrations");
      expect(tables).toContain("posts");

      // Migration 1 was not replayed (bare CREATE TABLE would fail);
      // migration 2 was recorded under the same flat-path convention.
      const rows = yield* queryAll<{ name: string }>(
        accountId,
        deployed.databaseId,
        "SELECT name FROM d1_migrations ORDER BY id;",
      );
      expect(rows.map((r) => r.name)).toEqual([
        "20240101000000_init/migration.sql",
        "20240102000000_posts/migration.sql",
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(deployed.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "migrates legacy 2-column migration table to wrangler schema",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
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

      yield* stack.destroy();

      // Step 1: deploy the database without migrations so we can seed a legacy
      // 2-column d1_migrations table on it before re-deploying with a
      // migrationsDir.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("LegacyMigrationDb");
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
      const upgraded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("LegacyMigrationDb", {
            migrationsDir,
          });
        }),
      );
      expect(upgraded.databaseId).toEqual(seeded.databaseId);

      const columns = yield* queryAll<{ name: string; type: string }>(
        accountId,
        seeded.databaseId,
        "PRAGMA table_info(d1_migrations);",
      );
      const colNames = columns.map((c) => c.name).sort();
      expect(colNames).toEqual(["applied_at", "id", "name"]);
      // The rebuild lands on wrangler's real shape: INTEGER ids.
      expect(columns.find((c) => c.name === "id")?.type).toBe("INTEGER");

      const records = yield* queryAll<{ id: number; name: string }>(
        accountId,
        seeded.databaseId,
        "SELECT id, name FROM d1_migrations ORDER BY id;",
      );
      const names = records.map((r) => r.name);
      expect(names).toContain("0000_initial_setup.sql");
      expect(names).toContain("0001_add_indexes.sql");
      expect(names).toContain("0002_create_users.sql");
      expect(names).toContain("0003_create_posts.sql");

      // Ids are sequential autoincrement ordinals preserving apply order.
      expect(records.map((r) => r.id)).toEqual(records.map((_, i) => i + 1));

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(seeded.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider("imports SQL files via importFiles", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
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

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("ImportDatabase", {
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

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("clones a database by databaseId", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
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

    yield* stack.destroy();

    const { source, target } = yield* stack.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1.Database("CloneByIdSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1.Database("CloneByIdTarget", {
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

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("clones a database by name lookup", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
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

    yield* stack.destroy();

    const { source, target } = yield* stack.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1.Database("CloneByNameSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1.Database("CloneByNameTarget", {
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

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider(
  "clones a database by passing the source resource directly",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
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

      yield* stack.destroy();

      const { source, target } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Cloudflare.D1.Database("CloneDirectSource", {
            importFiles: [seedPath],
          });
          const target = yield* Cloudflare.D1.Database("CloneDirectTarget", {
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

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
      yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
    }).pipe(logLevel),
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
      schedule: Schedule.max([
        Schedule.spaced(Duration.seconds(1)),
        Schedule.recurs(10),
      ]),
    }),
    Effect.orDie,
  );
});

// Engine-level adoption: D1 databases have no ownership signal (Cloudflare
// doesn't expose tags on D1), so a name match in `read` is treated as silent
// adoption.
test.provider(
  "existing database (matching name) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy normally so a real D1 database exists. No explicit
      // `name` — the engine generates a random-suffixed physical name
      // (collision-free across concurrent runs); the deploy output hands
      // back the real name, which pins the database's identity for the
      // adoption phase below.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("AdoptableDatabase");
        }),
      );
      const databaseName = initial.databaseName;
      const initialId = initial.databaseId;

      // Phase 2: wipe local state — the database stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists databases by name and returns plain
      // attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("AdoptableDatabase", {
            name: databaseName,
          });
        }),
      );

      // Same physical database — adoption, not re-creation.
      expect(adopted.databaseId).toEqual(initialId);
      expect(adopted.databaseName).toEqual(databaseName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({
        databaseId: initialId,
        databaseName,
      });

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
);

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
