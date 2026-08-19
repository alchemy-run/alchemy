import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Marker, SECRET_NAME, Site } from "./shared.ts";

/**
 * HTTP Service: reads the App secret via {@link Fly.ReadSecret} and
 * serves it back by name (never the plaintext).
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
    const secret = yield* Marker;
    const secrets = yield* Fly.ReadSecret(secret);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({
            ok: true,
            name: SECRET_NAME,
          });
        }
        if (url.pathname === "/secret") {
          const got = yield* secrets.get().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            ok: true,
            name: got.name,
          });
        }
        return yield* HttpServerResponse.json({
          ok: true,
          name: SECRET_NAME,
        });
      }),
    };
  }).pipe(Effect.provide(Fly.ReadSecretHttp)),
) {}
