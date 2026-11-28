import { expect } from "bun:test";
import * as Render from "@alchemy.run/render";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import pg from "pg";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Render.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test(
  "deploys Render Postgres (with migrations) and binds ConnectPostgres to WebService",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.dbId).toMatch(/^dpg-/);
    expect(out.url).toMatch(/^https:\/\/.+\.onrender\.com$/);
    expect(Redacted.value(out.databaseUrl).length).toBeGreaterThan(0);

    const rows = yield* Effect.tryPromise(async () => {
      const client = new pg.Client({
        connectionString: stripSslQueryParams(Redacted.value(out.externalDbUrl)),
        ssl: { rejectUnauthorized: false },
      });
      await client.connect();
      try {
        const res = await client.query<{ status: string }>(
          "SELECT status FROM alchemy_render_example",
        );
        return res.rows;
      } finally {
        await client.end();
      }
    });

    expect(rows.map((r) => r.status)).toEqual(["ready"]);
  }),
  { timeout: 120_000 },
);
