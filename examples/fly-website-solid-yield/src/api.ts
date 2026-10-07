import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** A basic Effect HTTP API on a Fly Machine, called by the solid-yield SPA. */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    main: import.meta.url,
    port: 3000,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({ status: 204, headers: cors });
        }
        if (path === "/api/greeting") {
          return yield* HttpServerResponse.json(
            { message: "Hello from the Fly API!", platform: "Fly" },
            { headers: cors },
          );
        }
        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404, headers: cors },
        );
      }).pipe(Effect.orDie),
    };
  }),
) {}
