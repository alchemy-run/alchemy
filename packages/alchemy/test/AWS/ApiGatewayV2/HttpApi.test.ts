import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import HttpApiTestFunctionLive, { HttpApiTestFunction } from "./http-handler";

const { test } = Test.make({ providers: AWS.providers() });

// Route + permission propagation after the first deploy takes a few
// seconds; cap the exponential backoff so we poll steadily.
const edgePropagationRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.modifyDelay((d: Duration.Duration) =>
          Effect.succeed(
            Duration.isGreaterThan(d, Duration.seconds(5))
              ? Duration.seconds(5)
              : d,
          ),
        ),
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

test.provider(
  "HTTP API proxies to Lambda (payload 2.0 end-to-end)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* HttpApiTestFunction.pipe(
            Effect.provide(HttpApiTestFunctionLive),
          );
          const { api, stage, url } = yield* AWS.ApiGatewayV2.HttpApi(
            "TestHttpApi",
            { handler: fn },
          );
          return {
            url,
            apiId: api.apiId,
            stageName: stage.stageName,
          };
        }),
      );

      expect(out.url).toContain(out.apiId);
      expect(out.stageName).toBe("$default");
      const baseUrl = out.url.replace(/\/+$/, "");

      // 1. Routing + query strings (retries through edge propagation).
      const echo = yield* edgePropagationRetry(
        HttpClient.get(`${baseUrl}/echo?foo=bar&baz=qux`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`echo returned ${response.status}`)),
          ),
        ),
      );
      expect(echo).toEqual({
        method: "GET",
        path: "/echo",
        query: { foo: "bar", baz: "qux" },
      });

      // 2. Path parameters.
      const item = yield* HttpClient.get(`${baseUrl}/items/widget-42`).pipe(
        Effect.flatMap((response) => response.json),
      );
      expect(item).toEqual({ id: "widget-42" });

      // 3. POST body round-trip.
      const created = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/items`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: "widget", count: 2 }),
        ),
      );
      expect(created.status).toBe(201);
      expect(yield* created.json).toEqual({
        received: { name: "widget", count: 2 },
      });

      // 4. Unknown routes fall through to the handler's 404.
      const missing = yield* HttpClient.get(`${baseUrl}/nope`);
      expect(missing.status).toBe(404);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
