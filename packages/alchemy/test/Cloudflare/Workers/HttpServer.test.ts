import {
  makeRequestEffect,
  type HttpEffect,
} from "@/Cloudflare/Workers/HttpServer";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/**
 * effect's `HttpClient` with its transport pointed at the Worker fetch
 * bridge: every request the client executes is dispatched into
 * `makeRequestEffect` exactly as workerd dispatches an incoming `fetch`
 * event, and errors reported inside the bridge are captured in `reported`.
 */
const makeBridgeClient = (handler: HttpEffect) => {
  const reported: Error[] = [];
  const client = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        Effect.runPromise(
          (
            makeRequestEffect(
              new Request(input, init) as any,
              handler,
            ) as Effect.Effect<Response>
          ).pipe(
            Effect.provide(
              ErrorReporter.layer([
                ErrorReporter.make(({ error }) => reported.push(error)),
              ]),
            ),
          ),
        )) as typeof globalThis.fetch),
    ),
  );
  return { client, reported };
};

describe("Cloudflare.Workers.HttpServer", () => {
  it.effect(
    "preserves Effect HTTP error responses without reporting ignored errors",
    () => {
      const { client, reported } = makeBridgeClient(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* Effect.die(
            new HttpServerError.RouteNotFound({ request }),
          );
        }),
      );

      return Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.get("https://worker.example/missing", {
          headers: { "cf-connecting-ip": "203.0.113.42" },
        });

        expect(response.status).toBe(404);
        expect(yield* response.text).toBe("");
        expect(reported).toHaveLength(0);
      }).pipe(Effect.provide(client));
    },
  );

  it.effect(
    "does not expose sensitive error context over a Worker response",
    () => {
      const sensitiveContext = [
        "sk_live_alchemy_super_secret",
        "tenant-customer-42",
        "/srv/alchemy/private/customer-42.json",
        "10.42.0.17",
      ];
      const { client, reported } = makeBridgeClient(
        Effect.fail(
          new Error(`Sensitive handler context: ${sensitiveContext.join(" ")}`),
        ).pipe(Effect.orDie),
      );

      return Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.get("https://worker.example/private", {
          headers: { "cf-connecting-ip": "203.0.113.42" },
        });

        const responseBody = yield* response.text;
        const wireResponse = [
          JSON.stringify(response.headers),
          responseBody,
        ].join("\n");

        expect(response.status).toBe(500);
        expect(responseBody).toBe("");
        for (const sensitiveValue of sensitiveContext) {
          expect(wireResponse).not.toContain(sensitiveValue);
          expect(
            reported.some((error) => error.message.includes(sensitiveValue)),
          ).toBe(true);
        }
      }).pipe(Effect.provide(client));
    },
  );
});
