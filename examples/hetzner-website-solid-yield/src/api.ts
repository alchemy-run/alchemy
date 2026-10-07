import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { API_PORT, Box } from "./shared.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** A basic Effect HTTP API on the shared Hetzner Server, called by the solid-yield SPA. */
export default class Api extends Hetzner.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const server = yield* Box;
    return {
      server,
      main: import.meta.url,
      port: API_PORT,
    };
  }),
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const path = new URL(request.url, "http://service").pathname;
      if (request.method === "OPTIONS") {
        return HttpServerResponse.empty({ status: 204, headers: cors });
      }
      // The Hetzner Service deploy waits on `GET /health` before it reports ready.
      if (path === "/health") {
        return yield* HttpServerResponse.json({ ok: true }, { headers: cors });
      }
      if (path === "/api/greeting") {
        return yield* HttpServerResponse.json(
          { message: "Hello from the Hetzner API!", platform: "Hetzner" },
          { headers: cors },
        );
      }
      return yield* HttpServerResponse.json({ error: "not found" }, { status: 404, headers: cors });
    }).pipe(Effect.orDie),
  }),
) {}
