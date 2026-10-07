import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Project } from "./project.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** A basic Effect HTTP API on a Neon Function, called by the solid-yield SPA. */
export default class Api extends Neon.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    return { project: yield* Project, main: import.meta.url };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://function").pathname;
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({ status: 204, headers: cors });
        }
        if (path === "/api/greeting") {
          return yield* HttpServerResponse.json(
            { message: "Hello from the Neon API!", platform: "Neon" },
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
