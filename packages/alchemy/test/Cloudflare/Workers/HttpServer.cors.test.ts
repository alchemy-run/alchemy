import { makeRequestEffect } from "@/Cloudflare/Workers/HttpServer.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * In-process pin of #175 / #404: wrapping a plain fetch handler with
 * `HttpMiddleware.cors()` must stamp Access-Control-Allow-Origin on
 * non-preflight responses, not only OPTIONS. Live coverage of the same
 * shape lives in Cors.test.ts (deployed Worker).
 */
const ORIGIN = "https://example.test";

const corsHandler = HttpMiddleware.cors()(
  HttpServerResponse.json({ message: "world" }),
);

const corsRequest = (method: string, extraHeaders?: Record<string, string>) =>
  new Request("https://worker.test/hello", {
    method,
    headers: { Origin: ORIGIN, ...extraHeaders },
  }) as any;

describe("makeRequestEffect drains HttpMiddleware.cors() pre-response handlers", () => {
  it.effect("tags GET responses with Access-Control-Allow-Origin", () =>
    Effect.gen(function* () {
      const response = yield* makeRequestEffect(
        corsRequest("GET"),
        corsHandler,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        message: "world",
      });
    }),
  );

  it.effect("tags OPTIONS preflight with Access-Control-Allow-Origin", () =>
    Effect.gen(function* () {
      const response = yield* makeRequestEffect(
        corsRequest("OPTIONS", { "Access-Control-Request-Method": "GET" }),
        corsHandler,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }),
  );

  it.effect("tags POST responses with Access-Control-Allow-Origin", () =>
    Effect.gen(function* () {
      const response = yield* makeRequestEffect(
        corsRequest("POST"),
        corsHandler,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }),
  );
});
