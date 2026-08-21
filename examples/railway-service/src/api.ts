import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Db, Site } from "./shared.ts";

/**
 * HTTP Service that binds Postgres via {@link Railway.ConnectPostgres}
 * and answers `select 1`. Set `RAILWAY_REGISTRY` to a prefix Railway
 * can pull (GHCR / Docker Hub) so Alchemy can push the bundled image.
 */
export default class Api extends Railway.Service<Api>()(
  "Api",
  {
    project: Site,
    main: import.meta.url,
    port: API_PORT,
    registry: process.env.RAILWAY_REGISTRY ?? "ghcr.io/example",
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const rows = yield* db.execute("select 1 as ok");
        if (path === "/health" || path === "/") {
          return yield* HttpServerResponse.json({ rows });
        }
        return yield* HttpServerResponse.json({ rows }, { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
) {}
