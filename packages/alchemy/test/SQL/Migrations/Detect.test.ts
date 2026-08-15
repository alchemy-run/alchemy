import {
  detectLayout,
  formatForLayout,
  inlineSqlParams,
  normalizeMigrationsInput,
  readDrizzleDirRecords,
  readFlatRecords,
  resolveMigrations,
  timestampPrefixMillis,
} from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe as plainDescribe, expect, layer, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

const describe = layer(NodeServices.layer);

describe("detectLayout", (it) => {
  it.effect("detects a drizzle-v1 layout by ts-dir + migration.sql", () =>
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("drizzle-v1"))).toBe("drizzle");
    }),
  );

  it.effect(
    "detects prisma by migration_lock.toml, never by timestamp shape",
    () =>
      // Prisma and drizzle-v1 dirs are otherwise identical
      // (`<ts>_<name>/migration.sql`); only the markers separate them.
      Effect.gen(function* () {
        expect(yield* detectLayout(fixture("prisma"))).toBe("prisma");
      }),
  );

  it.effect("detects flat .sql directories", () =>
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("flat"))).toBe("flat");
    }),
  );

  it.effect("fails on drizzle-v0 layouts with the drizzle-kit up hint", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(detectLayout(fixture("drizzle-v0")));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("DrizzleV0LayoutError");
        expect(result.failure.message).toContain("drizzle-kit up");
      }
    }),
  );

  it.effect("treats a missing directory as flat", () =>
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("does-not-exist"))).toBe("flat");
    }),
  );
});

describe("readers", (it) => {
  it.effect("drizzle records are keyed by directory name", () =>
    Effect.gen(function* () {
      const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
      expect(records.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_add_posts",
      ]);
      expect(records[0].createdAtMillis).toBe(Date.UTC(2024, 0, 1));
      // statement-breakpoint splitting
      expect(records[0].statements.length).toBe(2);
      expect(records[0].hash).toMatch(/^[0-9a-f]{64}$/);
    }),
  );

  it.effect("flat records are keyed by relative file path", () =>
    Effect.gen(function* () {
      const records = yield* readFlatRecords(fixture("flat"));
      expect(records.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
    }),
  );
});

describe("resolveMigrations", (it) => {
  const fresh = { hasHistory: false } as const;

  it.effect("fresh drizzle dir resolves to the drizzle format", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("drizzle-v1") },
        stamped: fresh,
        dialect: "sqlite",
      });
      expect(resolved.format).toBe("drizzle");
      expect(resolved.table).toBe("__drizzle_migrations");
      expect(resolved.schema).toBeUndefined();
    }),
  );

  it.effect("fresh drizzle dir on postgres gets the drizzle schema", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("drizzle-v1") },
        stamped: fresh,
        dialect: "postgres",
      });
      expect(resolved.schema).toBe("drizzle");
    }),
  );

  it.effect("fresh prisma dir resolves to the prisma format", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("prisma") },
        stamped: fresh,
        dialect: "postgres",
      });
      expect(resolved.format).toBe("prisma");
      expect(resolved.table).toBe("_prisma_migrations");
    }),
  );

  it.effect("fresh flat dir defaults to wrangler on sqlite", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("flat") },
        stamped: fresh,
        dialect: "sqlite",
      });
      expect(resolved.format).toBe("wrangler");
      expect(resolved.table).toBe("d1_migrations");
    }),
  );

  it.effect("fresh flat dir defaults to alchemy elsewhere", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("flat") },
        stamped: fresh,
        dialect: "postgres",
      });
      expect(resolved.format).toBe("alchemy");
      expect(resolved.table).toBe("__alchemy_migrations");
    }),
  );

  it.effect(
    "unstamped history skips detection: a drizzle dir with legacy state keeps the legacy format",
    () =>
      // The dangerous case: a pre-registry deploy applied a drizzle-layout
      // dir into the legacy table. Resolving to `drizzle` here would start
      // a second bookkeeping table and replay history.
      Effect.gen(function* () {
        const resolved = yield* resolveMigrations({
          input: { dir: fixture("drizzle-v1") },
          stamped: { hasHistory: true, table: "d1_migrations" },
          dialect: "sqlite",
        });
        expect(resolved.format).toBe("wrangler");
        expect(resolved.table).toBe("d1_migrations");
      }),
  );

  it.effect("unstamped history on postgres infers the alchemy format", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("flat") },
        stamped: { hasHistory: true, table: "neon_migrations" },
        dialect: "postgres",
      });
      expect(resolved.format).toBe("alchemy");
      // Legacy rows keep their persisted table name; only fresh resources
      // get the new default.
      expect(resolved.table).toBe("neon_migrations");
    }),
  );

  it.effect("a stamped format beats detection", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("drizzle-v1") },
        stamped: { format: "alchemy", hasHistory: true },
        dialect: "sqlite",
      });
      expect(resolved.format).toBe("alchemy");
    }),
  );

  it.effect("an explicit format contradicting the stamp fails the plan", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        resolveMigrations({
          input: { dir: fixture("drizzle-v1"), format: "drizzle" },
          stamped: { format: "wrangler", hasHistory: true },
          dialect: "sqlite",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("MigrationFormatMismatchError");
      }
    }),
  );

  it.effect(
    "an explicit format contradicting inferred legacy history fails too",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          resolveMigrations({
            input: { dir: fixture("drizzle-v1"), format: "drizzle" },
            stamped: { hasHistory: true },
            dialect: "sqlite",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
      }),
  );

  it.effect("an explicit format matching the stamp is allowed", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("drizzle-v1"), format: "drizzle" },
        stamped: { format: "drizzle", hasHistory: true },
        dialect: "sqlite",
      });
      expect(resolved.format).toBe("drizzle");
    }),
  );

  it.effect("an explicit table always wins", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMigrations({
        input: { dir: fixture("flat"), table: "my_migrations" },
        stamped: { hasHistory: true, table: "d1_migrations" },
        dialect: "sqlite",
      });
      expect(resolved.table).toBe("my_migrations");
    }),
  );
});

plainDescribe("normalizeMigrationsInput", () => {
  test("string is a directory", () => {
    expect(normalizeMigrationsInput("./migrations")).toEqual({
      dir: "./migrations",
    });
  });
  test("Drizzle.Schema-shaped outputs are accepted structurally", () => {
    expect(
      normalizeMigrationsInput({ out: "./migrations", format: "drizzle" }),
    ).toEqual({ dir: "./migrations", format: "drizzle" });
  });
  test("object form passes through", () => {
    expect(
      normalizeMigrationsInput({ dir: "./m", format: "wrangler", table: "t" }),
    ).toEqual({ dir: "./m", format: "wrangler", table: "t" });
  });
});

plainDescribe("helpers", () => {
  test("timestampPrefixMillis parses drizzle dir prefixes", () => {
    expect(timestampPrefixMillis("20240101000000_init")).toBe(
      Date.UTC(2024, 0, 1),
    );
    expect(timestampPrefixMillis("0001_users.sql")).toBeUndefined();
  });

  test("inlineSqlParams inlines ? placeholders outside quotes", () => {
    expect(
      inlineSqlParams(
        "INSERT INTO t (a, b) VALUES (?, ?);",
        ["it's", 42],
        "sqlite",
      ),
    ).toBe("INSERT INTO t (a, b) VALUES ('it''s', 42);");
    expect(
      inlineSqlParams(
        "SELECT * FROM t WHERE a = 'lit?' AND b = ?;",
        [1],
        "sqlite",
      ),
    ).toBe("SELECT * FROM t WHERE a = 'lit?' AND b = 1;");
  });

  test("inlineSqlParams inlines $n placeholders for postgres", () => {
    expect(inlineSqlParams("SELECT $1, $2;", ["x", null], "postgres")).toBe(
      "SELECT 'x', NULL;",
    );
  });
});
