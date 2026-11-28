import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Render from "@alchemy.run/render";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import pg from "pg";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.Postgres", { tags: ["provider:render", "live"], timeout: 240_000 }, () => {
  t.test.provider(
    "provisions Postgres with migrations, ConnectPostgres binding on WebService, plans noop, updates, and destroys",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.Postgres);
        const migDir = yield* Effect.tryPromise(() =>
          fs.mkdtemp(path.join(os.tmpdir(), "alchemy-render-pg-")),
        );
        yield* Effect.tryPromise(() =>
          fs.writeFile(
            path.join(migDir, "0001_init.sql"),
            [
              "CREATE TABLE IF NOT EXISTS alchemy_render_live_check (",
              "  id SERIAL PRIMARY KEY,",
              "  label TEXT NOT NULL",
              ");",
              "INSERT INTO alchemy_render_live_check (label) VALUES ('ok');",
            ].join("\n"),
            "utf8",
          ),
        );

        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const db = yield* Render.Postgres("Db", {
              plan: "basic_256mb",
              region: "oregon",
              version: "16",
              diskSizeGB: 5,
              ipAllowList: [
                {
                  cidrBlock: "0.0.0.0/0",
                  description: `alchemy-live-${version}`,
                },
              ],
              migrations: migDir,
            });

            const web = yield* Render.WebService(
              "BoundWeb",
              {
                plan: "free",
                region: "oregon",
                skipDeployAfterUpdate: true,
                runtimeSource: {
                  image: {
                    imagePath: "docker.io/nginxdemos/hello",
                    tag: "plain-text",
                  },
                },
              },
              Effect.gen(function* () {
                yield* Render.ConnectPostgres(db);
              }).pipe(Effect.provide(Render.ConnectPostgresHttp)),
            );

            return { db, web };
          });

        yield* Effect.gen(function* () {
          const created = yield* stack.deploy(program("v1"));
          expect(created.db.status).toBe("available");
          expect(created.db.origin.port).toBe(5432);
          expect(["none", "pgbouncer"]).toContain(created.db.connectionPool);
          expect(Object.keys(created.db.migrationsHashes)).toContain("0001_init.sql");

          // Verify bound DATABASE_URL landed on WebService
          expect(Redacted.value(created.web.envVars[Render.DATABASE_URL_ENV])).toBe(
            Redacted.value(created.db.connectionInfo.internalConnectionString),
          );

          // Verify migrations actually ran on live Postgres
          const rows = yield* Effect.tryPromise(async () => {
            const client = new pg.Client({
              connectionString: stripSslQueryParams(
                Redacted.value(created.db.connectionInfo.externalConnectionString),
              ),
              ssl: { rejectUnauthorized: false },
            });
            await client.connect();
            try {
              const res = await client.query<{ label: string }>(
                "SELECT label FROM alchemy_render_live_check",
              );
              return res.rows;
            } finally {
              await client.end();
            }
          });
          expect(rows.map((r) => r.label)).toEqual(["ok"]);

          const exportsList = yield* Render.listPostgresExports(created.db.id);
          expect(Array.isArray(exportsList)).toBe(true);

          const found = yield* prov.lookup!({ id: created.db.id });
          expect(found?.id).toBe(created.db.id);
          expect((yield* prov.list!()).some((d) => d.id === created.db.id)).toBe(true);

          yield* expectAllNoop(stack, program("v1"));

          const updated = yield* stack.deploy(program("v2"));
          expect(updated.db.id).toBe(created.db.id);
          expect(updated.db.ipAllowList[0]?.description).toBe("alchemy-live-v2");

          yield* stack.destroy();
          expect(yield* prov.lookup!({ id: created.db.id })).toBeUndefined();
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise(() => fs.rm(migDir, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
          ),
        );
      }),
    { tags: ["provider:render", "live"], timeout: 240_000 },
  );
});
