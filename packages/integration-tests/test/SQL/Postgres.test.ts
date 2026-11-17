import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { exerciseSqlSurface, getJson, postJson, putJson } from "./exercise.ts";
import Stack from "./fixtures/postgres-stack.ts";
import type { UserRow } from "./fixtures/routes.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

/**
 * End-to-end test of `SQL.Postgres` — an `@effect/sql-pg` client that
 * opens its pool per execution — against a real Cloudflare
 * Worker fronting a Neon Postgres origin through Hyperdrive (caching
 * disabled for read-after-write assertions).
 *
 * Runs the same shared exercise as the D1 suite, plus the Postgres-only
 * surface: `withTransaction` (commit + rollback), multi-row
 * `sql.updateValues`, `sql.json`, a streamed statement, and a
 * `Drizzle.Postgres` CTE built at Construction phase.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

test(
  "SQL.Postgres exercises the full client surface over a deployed Worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* exerciseSqlSurface(url);

    // withTransaction — both inserts commit atomically.
    const dave: UserRow = { id: 10, name: "dave", email: "dave@example.com" };
    const erin: UserRow = { id: 11, name: "erin", email: "erin@example.com" };
    const committed = (yield* postJson(`${url}/tx/commit`, [dave, erin])) as {
      rows: UserRow[];
    };
    expect(committed.rows).toEqual([dave, erin]);

    // withTransaction — a failing effect rolls the insert back.
    const rolledBack = (yield* postJson(`${url}/tx/rollback`, {
      id: 12,
      name: "frank",
      email: "frank@example.com",
    })) as { error: string; rows: unknown[] };
    expect(rolledBack.error).toBe("Rollback");
    expect(rolledBack.rows).toEqual([]);

    // sql.updateValues — multi-row update through a VALUES join.
    const daveV2: UserRow = {
      id: 10,
      name: "david",
      email: "david@example.com",
    };
    const erinV2: UserRow = {
      id: 11,
      name: "erina",
      email: "erina@example.com",
    };
    const updated = (yield* putJson(`${url}/users/values`, [daveV2, erinV2])) as {
      rows: UserRow[];
    };
    expect(updated.rows).toEqual([daveV2, erinV2]);

    // sql.json — the value reaches Postgres as one JSON parameter.
    const doc = { tags: ["a", "b"], nested: { n: 1 } };
    expect(yield* postJson(`${url}/json`, doc)).toEqual({ doc });

    // A streamed statement.
    expect(yield* getJson(`${url}/users/stream`)).toEqual({ ids: [1, 2, 3, 10, 11] });

    // Drizzle.Postgres — a CTE column inside a `sql` fragment and a join
    // condition, built before any connection (alchemy-run/alchemy#2001).
    const cte = (yield* getJson(`${url}/drizzle/cte`)) as {
      sql: string;
      rows: Array<{ id: number; n: number }>;
    };
    expect(cte.sql).toContain('count("everyone"."id")');
    expect(cte.sql).toContain('on "everyone"."name" = "alchemy_sql_users"."name"');
    expect(cte.rows).toEqual([1, 2, 3, 10, 11].map((id) => ({ id, n: 1 })));
  }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);
