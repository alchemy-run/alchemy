import { sql as drizzleSql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle/LibSQL";
import * as SQL from "@/SQL/LibSQL";
import * as Turso from "@/Turso";
import { BindingDb, TenantGroup } from "./resources.ts";

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey(),
  body: text("body").notNull(),
});

export default class TursoWorker extends Cloudflare.Worker<TursoWorker>()(
  "TursoWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const conn = yield* Turso.Connect(BindingDb);
    const sql = yield* SQL.LibSQL(conn);
    const db = yield* Drizzle.LibSQL(conn);
    const tenants = yield* Turso.ManageDatabases(TenantGroup);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/sql") {
          yield* sql`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
          yield* sql`INSERT INTO notes (body) VALUES (${"from-sql"})`;
          const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM notes`;
          return yield* HttpServerResponse.json({ count: rows[0]?.n });
        }

        if (url.pathname === "/tx") {
          yield* sql`CREATE TABLE IF NOT EXISTS ledger (v INTEGER NOT NULL)`;
          const before = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ledger`;
          // The second insert violates NOT NULL, so the first must roll back.
          const failed = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO ledger (v) VALUES (${1})`;
                yield* sql`INSERT INTO ledger (v) VALUES (${null})`;
              }),
            )
            .pipe(
              Effect.as(false),
              Effect.catchTag("SqlError", () => Effect.succeed(true)),
            );
          const after = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ledger`;
          return yield* HttpServerResponse.json({
            failed,
            before: before[0]?.n,
            after: after[0]?.n,
          });
        }

        if (url.pathname === "/drizzle") {
          yield* db.insert(notes).values({ body: "from-drizzle" });
          const rows = yield* db
            .select()
            .from(notes)
            .where(drizzleSql`body = 'from-drizzle'`);
          return yield* HttpServerResponse.json({ bodies: rows.map((r) => r.body) });
        }

        if (url.pathname === "/tenant") {
          const name = url.searchParams.get("name")!;
          const created = yield* tenants.create(name);
          const tenantSql = yield* SQL.LibSQL(tenants.connect(created.name));
          yield* tenantSql`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)`;
          yield* tenantSql`INSERT INTO kv VALUES ('tenant', ${name})`;
          const rows = yield* tenantSql<{ v: string }>`SELECT v FROM kv`;
          const listed = yield* tenants.list();
          yield* tenants.delete(created.name);
          const afterDelete = yield* tenants.get(created.name);
          return yield* HttpServerResponse.json({
            url: created.url,
            value: rows[0]?.v,
            listed: listed.map((d) => d.name),
            deleted: afterDelete === undefined,
          });
        }

        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Turso.ConnectHttp, Turso.ManageDatabasesHttp))),
) {}
