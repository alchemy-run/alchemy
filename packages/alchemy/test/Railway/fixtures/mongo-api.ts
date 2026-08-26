import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const MONGO_HTTP_PORT = 3000;

export const Site = Railway.Project("Site");

export const Db = Railway.mongo("Db", { project: Site });

/**
 * HTTP Service that binds Mongo via {@link Railway.ConnectMongo}
 * and answers ping. Never returns the connection string.
 */
export default class MongoApi extends Railway.Service<MongoApi>()(
  "MongoApi",
  {
    project: Site,
    main: import.meta.url,
    port: MONGO_HTTP_PORT,
    build: { install: ["mongodb"] },
  },
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
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ConnectMongoHttp)),
) {}
