import * as Fly from "alchemy/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Db, Site } from "./shared.ts";

/**
 * HTTP Service that attaches Managed Postgres and reports whether
 * DATABASE_URL is present. Never returns the connection string.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    yield* Fly.AttachPostgres(Db);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const databaseUrl = yield* Config.redacted("DATABASE_URL").pipe(
          Effect.orElseSucceed(() => Redacted.make("")),
        );
        const present = Redacted.value(databaseUrl).length > 0;
        if (path === "/health") {
          return yield* HttpServerResponse.json({ ok: present });
        }
        return yield* HttpServerResponse.json({ ok: present });
      }),
    };
  }).pipe(Effect.provide(Fly.AttachPostgresLive)),
) {}
