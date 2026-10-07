import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Site } from "./shared.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** A basic Effect HTTP API on a Railway Service, called by the solid-yield SPA. */
export default class Api extends Railway.Service<Api>()(
  "Api",
  {
    project: Site,
    main: import.meta.url,
    port: 3000,
    healthcheck: "/api/greeting",
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
            { message: "Hello from the Railway API!", platform: "Railway" },
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
