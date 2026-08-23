import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { canPushRailwayImage, railwayRegistry } from "./registry.ts";

export const MONGO_HTTP_PORT = 3000;

export const Site = Railway.Project("Site");

export const Db = Railway.mongo("Db", { project: Site });

/**
 * HTTP Service that binds Mongo via {@link Railway.ConnectMongo}
 * and answers ping. Never returns the connection string.
 *
 * When `RAILWAY_REGISTRY` and push credentials are set, `main` is bundled
 * and pushed. Otherwise docker push is impossible: the same ConnectMongo
 * init still packs `MONGO_URL`, and Railway runs `hashicorp/http-echo`
 * for HTTP health.
 */
export default class MongoApi extends Railway.Service<MongoApi>()(
  "MongoApi",
  Effect.gen(function* () {
    if (canPushRailwayImage) {
      return {
        project: Site,
        main: import.meta.url,
        registry: railwayRegistry,
        port: MONGO_HTTP_PORT,
        build: { install: ["mongodb"] },
      };
    }
    const db = yield* Db;
    return {
      project: Site,
      image: "hashicorp/http-echo",
      port: 5678,
      env: {
        MONGO_URL: db.connectionUri,
      },
    };
  }),
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectMongo(Db);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        const url = yield* conn.connectionString;
        const ping = yield* Railway.pingMongo(Redacted.value(url));
        if (path === "/health" || path === "/") {
          return yield* HttpServerResponse.json(ping);
        }
        return yield* HttpServerResponse.json(ping, { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Railway.ConnectMongoHttp)),
) {}
