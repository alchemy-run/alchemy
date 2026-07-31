import { CloudflareApiHttpClient } from "@/Cloudflare/ApiConcurrency";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/** Wrap a stub request handler with the bounded Cloudflare API layer. */
const wrappedClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) =>
  CloudflareApiHttpClient.pipe(
    Layer.provide(
      Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler)),
    ),
  );

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("Cloudflare ApiConcurrency", () => {
  it.live("bounds concurrent requests to api.cloudflare.com", () =>
    Effect.gen(function* () {
      let inFlight = 0;
      let maxInFlight = 0;
      const layer = wrappedClient((request) =>
        Effect.gen(function* () {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          yield* Effect.sleep("20 millis");
          inFlight--;
          return jsonResponse(request, 200, `{"success":true,"result":{}}`);
        }),
      );

      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* Effect.all(
          Array.from({ length: 40 }, () =>
            client.get("https://api.cloudflare.com/client/v4/accounts/test"),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer));

      // The default pool size is 10: 40 simultaneous requests must saturate
      // it exactly, never exceed it.
      expect(maxInFlight).toBe(10);
    }),
  );

  it.live("does not throttle requests to other hosts", () =>
    Effect.gen(function* () {
      let inFlight = 0;
      let maxInFlight = 0;
      const layer = wrappedClient((request) =>
        Effect.gen(function* () {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          yield* Effect.sleep("20 millis");
          inFlight--;
          return jsonResponse(request, 200, "{}");
        }),
      );

      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* Effect.all(
          Array.from({ length: 40 }, () =>
            client.get("https://example.com/readiness"),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer));

      expect(maxInFlight).toBeGreaterThan(10);
    }),
  );

  it.live("warns once per endpoint on 401 responses", () =>
    Effect.gen(function* () {
      const warnings: string[] = [];
      const captureWarnings = Logger.layer([
        Logger.make((options) => {
          if (options.logLevel === "Warn") {
            warnings.push(String(options.message));
          }
        }),
      ]);
      const layer = wrappedClient((request) =>
        Effect.succeed(
          jsonResponse(
            request,
            401,
            `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        // Same endpoint three times (e.g. the SDK retry policy re-issuing a
        // throttled call) plus one distinct endpoint.
        yield* client.get("https://api.cloudflare.com/client/v4/accounts/foo");
        yield* client.get("https://api.cloudflare.com/client/v4/accounts/foo");
        yield* client.get("https://api.cloudflare.com/client/v4/accounts/foo");
        yield* client.get("https://api.cloudflare.com/client/v4/zones/bar");
      }).pipe(Effect.provide([layer, captureWarnings]));

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("GET /client/v4/accounts/foo");
      expect(warnings[1]).toContain("GET /client/v4/zones/bar");
    }),
  );

  it.live("does not warn on successful responses", () =>
    Effect.gen(function* () {
      const warnings: string[] = [];
      const captureWarnings = Logger.layer([
        Logger.make((options) => {
          if (options.logLevel === "Warn") {
            warnings.push(String(options.message));
          }
        }),
      ]);
      const layer = wrappedClient((request) =>
        Effect.succeed(
          jsonResponse(request, 200, `{"success":true,"result":{}}`),
        ),
      );

      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* client.get("https://api.cloudflare.com/client/v4/accounts/foo");
      }).pipe(Effect.provide([layer, captureWarnings]));

      expect(warnings).toHaveLength(0);
    }),
  );
});
