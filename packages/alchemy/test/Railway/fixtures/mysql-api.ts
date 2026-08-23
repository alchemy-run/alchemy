import * as Drizzle from "@/Drizzle/MySQL.ts";
import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { canPushRailwayImage, railwayRegistry } from "./registry.ts";

export const MYSQL_API_PORT = 3000;

export const Site = Railway.Project("Site");

export const Db = Railway.MySQL("Db", { project: Site });

/**
 * HTTP Service that binds MySQL via {@link Railway.ConnectMySQL}
 * and answers SELECT 1. Never returns the connection string.
 *
 * When `RAILWAY_REGISTRY` and push credentials are set, `main` is bundled
 * and pushed. Otherwise docker push is impossible: the same ConnectMySQL
 * init still packs `MYSQL_URL`, and Railway runs `hashicorp/http-echo`
 * for HTTP health.
 */
export default class MySQLApi extends Railway.Service<MySQLApi>()(
  "MySQLApi",
  Effect.gen(function* () {
    if (canPushRailwayImage) {
      return {
        project: Site,
        main: import.meta.url,
        registry: railwayRegistry,
        port: MYSQL_API_PORT,
        build: { install: ["mysql2"] },
      };
    }
    const db = yield* Db;
    return {
      project: Site,
      image: "hashicorp/http-echo",
      port: 5678,
      env: {
        MYSQL_URL: db.connectionUri,
      },
    };
  }),
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectMySQL(Db);
    const db = yield* Drizzle.MySQL(conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        const rows = yield* db.execute("select 1 as ok", "objects");
        if (path === "/health" || path === "/") {
          return yield* HttpServerResponse.json({ rows });
        }
        return yield* HttpServerResponse.json({ rows }, { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Railway.ConnectMySQLHttp)),
) {}
