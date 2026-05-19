import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { PingRpcs } from "./fixtures/rpc-http/group.ts";
import Stack from "./fixtures/rpc-http/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// The Cloudflare Worker fetch adapter (`workersHttpHandler`) currently
// short-circuits Effect's standard HTTP lifecycle (it manually
// provides `HttpServerRequest` and converts the response to a web
// `Response` outside of `HttpEffect.toHandled`). PR #328 reported that
// this can deadlock `RpcServer.toHttpEffect` under workerd. This test
// hammers a real deployed Worker exposing an Effect RPC group to
// surface lifecycle / per-request scope regressions.
const clientLayer = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.ndjson),
    ),
  );

test(
  "RpcServer.toHttpEffect: unary RPC response",
  Effect.gen(function* () {
    const { url } = yield* stack;
    console.log("url:", url);

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(PingRpcs);
      const result = yield* client.Ping({ message: "hello" }).pipe(
        Effect.tapError(Console.log),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );
      expect(result.echo).toBe("hello");
      expect(result.n).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: streaming RPC response",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(PingRpcs);
      const values = yield* client.Count({ upto: 5 }).pipe(
        Stream.runCollect,
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );
      expect(values).toEqual([1, 2, 3, 4, 5]);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: 200 concurrent unary calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(PingRpcs);

      const N = 200;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client.Ping({ message: `m-${i}` }).pipe(Effect.timeout("5 seconds")),
        { concurrency: 64 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: concurrent streaming calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(PingRpcs);

      const N = 64;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client
            .Count({ upto: 3 + (i % 3) })
            .pipe(Stream.runCollect, Effect.timeout("5 seconds")),
        { concurrency: N },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i]).toEqual(
          Array.from({ length: 3 + (i % 3) }, (_, n) => n + 1),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: slow handler under concurrency does not leak request scope",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(PingRpcs);

      const N = 64;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        () => client.Slow({ ms: 250 }).pipe(Effect.timeout("5 seconds")),
        { concurrency: N },
      );

      expect(results).toHaveLength(N);
      for (const r of results) expect(r.slept).toBe(250);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);
