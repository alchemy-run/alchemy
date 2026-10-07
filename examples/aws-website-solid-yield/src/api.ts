import * as Lambda from "alchemy/AWS/Lambda";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * A basic Effect HTTP API on a Lambda Function, called by the solid-yield
 * SPA. The public Function URL is https, so the CloudFront-served SPA can
 * call it without mixed-content errors.
 */
export default class Api extends Lambda.Function<Api>()(
  "Api",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.originalUrl, "http://lambda").pathname;
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({ status: 204, headers: cors });
        }
        if (path === "/api/greeting") {
          return yield* HttpServerResponse.json(
            { message: "Hello from the AWS API!", platform: "AWS" },
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
