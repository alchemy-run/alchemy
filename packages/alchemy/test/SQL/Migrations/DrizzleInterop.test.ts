import { applyDrizzleFormat } from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Database } from "bun:sqlite";
import { expect, layer } from "alchemy-test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import * as Effect from "effect/Effect";
import { makeSqliteExecutor, tableNames } from "./sqlite-executor.ts";

/**
 * Interop is the property that matters (design doc §6): after Alchemy
 * applies, drizzle's own migrator must see nothing pending — and vice
 * versa. These tests run drizzle-orm's REAL migrator (bun-sqlite driver)
 * against the same database our proxy-delegated flow uses.
 */

const fixturesDir = new URL("./fixtures/drizzle-v1", import.meta.url).pathname;

const describe = layer(NodeServices.layer);

const migrationRows = (db: Database) =>
  db
    .query(
      "SELECT id, hash, created_at, name FROM __drizzle_migrations ORDER BY id;",
    )
    .all() as Array<{
    id: number;
    hash: string;
    created_at: number;
    name: string;
  }>;

describe("drizzle interop (sqlite)", (it) => {
  it.effect("alchemy-first: drizzle's migrator sees nothing pending", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);

      yield* applyDrizzleFormat({ executor, dir: fixturesDir });

      expect(tableNames(db)).toEqual(
        expect.arrayContaining(["__drizzle_migrations", "posts", "users"]),
      );
      const afterOurs = migrationRows(db);
      expect(afterOurs.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_add_posts",
      ]);
      expect(afterOurs[0].created_at).toBe(Date.UTC(2024, 0, 1));

      // Now drizzle's own migrator: it must match every row by name and
      // run nothing (a replay would throw on the bare CREATE TABLEs).
      yield* Effect.sync(() =>
        drizzleMigrate(drizzle({ client: db }), {
          migrationsFolder: fixturesDir,
        }),
      );
      expect(migrationRows(db)).toEqual(afterOurs);
    }),
  );

  it.effect("drizzle-first: our flow sees nothing pending (adoption)", () =>
    // Seth's case: `drizzle-kit generate` + `drizzle-kit migrate` happened
    // before Alchemy ever saw the database. No baselining required.
    Effect.gen(function* () {
      const db = new Database(":memory:");
      yield* Effect.sync(() =>
        drizzleMigrate(drizzle({ client: db }), {
          migrationsFolder: fixturesDir,
        }),
      );
      const afterTheirs = migrationRows(db);
      expect(afterTheirs.length).toBe(2);

      const executor = makeSqliteExecutor(db);
      yield* applyDrizzleFormat({ executor, dir: fixturesDir });
      expect(migrationRows(db)).toEqual(afterTheirs);
    }),
  );

  it.effect("our flow is idempotent across repeated deploys", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      yield* applyDrizzleFormat({ executor, dir: fixturesDir });
      const first = migrationRows(db);
      yield* applyDrizzleFormat({ executor, dir: fixturesDir });
      expect(migrationRows(db)).toEqual(first);
    }),
  );

  it.effect(
    "hashes we record byte-match drizzle's (checksum interop, not just names)",
    () =>
      Effect.gen(function* () {
        const ourDb = new Database(":memory:");
        yield* applyDrizzleFormat({
          executor: makeSqliteExecutor(ourDb),
          dir: fixturesDir,
        });
        const theirDb = new Database(":memory:");
        yield* Effect.sync(() =>
          drizzleMigrate(drizzle({ client: theirDb }), {
            migrationsFolder: fixturesDir,
          }),
        );
        expect(migrationRows(ourDb).map((r) => r.hash)).toEqual(
          migrationRows(theirDb).map((r) => r.hash),
        );
      }),
  );
});
