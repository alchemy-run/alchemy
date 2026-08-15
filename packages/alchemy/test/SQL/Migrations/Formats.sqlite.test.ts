import {
  applyAlchemyFormat,
  applyMigrations,
  applyWranglerFormat,
  readDrizzleDirRecords,
  readFlatRecords,
  type MigrationRecord,
} from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Database } from "bun:sqlite";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeSqliteExecutor, tableNames } from "./sqlite-executor.ts";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

const describe = layer(NodeServices.layer);

const record = (
  name: string,
  sql: string,
  overrides?: Partial<MigrationRecord>,
): MigrationRecord => ({
  name,
  hash: "0".repeat(64),
  createdAtMillis: undefined,
  sql,
  statements: [sql],
  ...overrides,
});

describe("wrangler format", (it) => {
  it.effect("creates wrangler's real table shape and applies in order", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      yield* applyWranglerFormat({
        executor,
        table: "d1_migrations",
        records,
      });

      expect(tableNames(db)).toEqual(
        expect.arrayContaining(["d1_migrations", "posts", "users"]),
      );
      const columns = db
        .query("PRAGMA table_info(d1_migrations);")
        .all() as Array<{ name: string; type: string }>;
      expect(columns.map((c) => c.name)).toEqual(["id", "name", "applied_at"]);
      expect(columns.find((c) => c.name === "id")?.type).toBe("INTEGER");

      const rows = db
        .query("SELECT id, name, applied_at FROM d1_migrations ORDER BY id;")
        .all() as Array<{ id: number; name: string; applied_at: string }>;
      expect(rows.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
      expect(rows[0].id).toBe(1);
      expect(rows[0].applied_at).toBeTruthy();
    }),
  );

  it.effect("is idempotent — replaying would fail on CREATE TABLE", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      yield* applyWranglerFormat({ executor, table: "d1_migrations", records });
      // The fixture SQL uses bare CREATE TABLE — a replay would throw.
      yield* applyWranglerFormat({ executor, table: "d1_migrations", records });
      const [{ n }] = db
        .query("SELECT COUNT(*) AS n FROM d1_migrations;")
        .all() as Array<{ n: number }>;
      expect(n).toBe(2);
    }),
  );

  it.effect("applies only pending migrations on subsequent runs", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      yield* applyWranglerFormat({
        executor,
        table: "d1_migrations",
        records: records.slice(0, 1),
      });
      yield* applyWranglerFormat({ executor, table: "d1_migrations", records });
      const rows = db
        .query("SELECT name FROM d1_migrations ORDER BY id;")
        .all() as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
    }),
  );

  it.effect(
    "upgrades the legacy Alchemy 3-column table in place without replaying",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // A pre-registry deploy: our invented shape, TEXT id.
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '0001_users.sql', '2024-01-01 00:00:00');",
        );
        // ...and migration 0001 really ran:
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyWranglerFormat({
          executor,
          table: "d1_migrations",
          records,
        });

        const columns = db
          .query("PRAGMA table_info(d1_migrations);")
          .all() as Array<{ name: string; type: string }>;
        expect(columns.find((c) => c.name === "id")?.type).toBe("INTEGER");
        const rows = db
          .query("SELECT id, name FROM d1_migrations ORDER BY id;")
          .all() as Array<{ id: number; name: string }>;
        expect(rows.map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
        // 0001 was not replayed (its CREATE TABLE would have thrown),
        // 0002 was applied fresh.
        expect(tableNames(db)).toContain("posts");
      }),
  );

  it.effect(
    "upgrades the oldest 2-column shape, reading names from the primary column",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyWranglerFormat({
          executor,
          table: "d1_migrations",
          records,
        });
        const rows = db
          .query("SELECT name FROM d1_migrations ORDER BY id;")
          .all() as Array<{ name: string }>;
        expect(rows.map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
      }),
  );

  it.effect("refuses to write into a drizzle-shaped table", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      db.run(
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT);",
      );
      const executor = makeSqliteExecutor(db);
      const result = yield* Effect.result(
        applyWranglerFormat({
          executor,
          table: "d1_migrations",
          records: [record("0001_x.sql", "SELECT 1;")],
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("MigrationError");
        expect(result.failure.message).toContain("drizzle");
      }
    }),
  );
});

describe("alchemy format (sqlite)", (it) => {
  it.effect("creates drizzle's column shape under the neutral table", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records,
      });
      const columns = db
        .query("PRAGMA table_info(__alchemy_migrations);")
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toEqual([
        "id",
        "hash",
        "created_at",
        "name",
        "applied_at",
      ]);
      const rows = db
        .query(
          "SELECT hash, name, applied_at FROM __alchemy_migrations ORDER BY id;",
        )
        .all() as Array<{ hash: string; name: string; applied_at: string }>;
      expect(rows.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
      expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].applied_at).toBeTruthy();

      // Idempotent.
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records,
      });
      const [{ n }] = db
        .query("SELECT COUNT(*) AS n FROM __alchemy_migrations;")
        .all() as Array<{ n: number }>;
      expect(n).toBe(2);
    }),
  );

  it.effect(
    "upgrades a legacy table, backfilling hashes from local records",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE __alchemy_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO __alchemy_migrations (id, name, applied_at) VALUES ('00001', '0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });

        const rows = db
          .query(
            "SELECT hash, name, applied_at FROM __alchemy_migrations ORDER BY id;",
          )
          .all() as Array<{ hash: string; name: string; applied_at: string }>;
        expect(rows.map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
        // Backfilled from the matching local record, not a placeholder.
        expect(rows[0].hash).toBe(records[0].hash);
        // The original applied_at survives the rebuild.
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");
        expect(tableNames(db)).toContain("posts");
      }),
  );

  it.effect(
    "legacy rows recorded as dir/migration.sql keep matching drizzle-layout records",
    () =>
      // Pre-registry Alchemy applied drizzle-layout dirs under the flat
      // key (`<dir>/migration.sql`). After the upgrade the old key is
      // preserved and applied-detection must not replay.
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '20240101000000_init/migration.sql', '2024-01-01 00:00:00');",
        );
        // Migration 1 really ran:
        db.run(
          "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
        );
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        yield* applyAlchemyFormat({
          executor,
          table: "d1_migrations",
          records,
        });

        const rows = db
          .query("SELECT name FROM d1_migrations ORDER BY id;")
          .all() as Array<{ name: string }>;
        expect(rows.map((r) => r.name)).toEqual([
          "20240101000000_init/migration.sql",
          "20240102000000_add_posts",
        ]);
        expect(tableNames(db)).toContain("posts");
      }),
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
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
          expect(result.failure.message).toContain("zzz_deleted.sql");
        }
      }),
  );
});

describe("registry apply", (it) => {
  it.effect("prisma format without a connection string is a typed error", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const result = yield* Effect.result(
        applyMigrations({
          resolved: {
            dir: fixture("prisma"),
            format: "prisma",
            table: "_prisma_migrations",
            schema: undefined,
          },
          executor,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("MigrationFormatUnsupportedError");
        expect(result.failure.message).toContain("prisma migrate diff");
      }
    }),
  );

  it.effect("wrangler format on a non-sqlite dialect is a typed error", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = {
        ...makeSqliteExecutor(db),
        dialect: "postgres" as const,
      };
      const result = yield* Effect.result(
        applyMigrations({
          resolved: {
            dir: fixture("flat"),
            format: "wrangler",
            table: "d1_migrations",
            schema: undefined,
          },
          executor,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("MigrationFormatUnsupportedError");
      }
    }),
  );

  it.effect("alchemy format keys drizzle-layout dirs by directory name", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      yield* applyMigrations({
        resolved: {
          dir: fixture("drizzle-v1"),
          format: "alchemy",
          table: "__alchemy_migrations",
          schema: undefined,
        },
        executor,
      });
      const rows = db
        .query("SELECT name FROM __alchemy_migrations ORDER BY id;")
        .all() as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_add_posts",
      ]);
    }),
  );
});
