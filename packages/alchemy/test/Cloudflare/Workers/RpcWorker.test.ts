import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import {
  CallerRpcs,
  TargetRpcs,
} from "./fixtures/rpc-worker-binding/group.ts";
import Stack from "./fixtures/rpc-worker-binding/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const clientLayer = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.ndjson),
    ),
  );

test(
  "RpcWorker: target worker exposes Greet",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(TargetRpcs);
      const result = yield* client.Greet({ name: "world" }).pipe(
        Effect.tapError(Console.log),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );
      expect(result.greeting).toBe("hello world");
    }).pipe(Effect.scoped, Effect.provide(clientLayer(targetUrl)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcWorker.bind: caller proxies through service binding to target",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(CallerRpcs);
      const result = yield* client.ProxyGreet({ name: "alchemy" }).pipe(
        Effect.tapError(Console.log),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );
      expect(result.greeting).toBe("hello alchemy");
    }).pipe(Effect.scoped, Effect.provide(clientLayer(callerUrl)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcWorker.bind: 100 concurrent ProxyGreet calls do not hang",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(CallerRpcs);

      // Warm the service binding by serially exercising it before the
      // burst — workerd surfaces "Worker not found" defects until the
      // target script is fully propagated to the same edge that the
      // caller worker hits.
      yield* client.ProxyGreet({ name: "warmup" }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client.ProxyGreet({ name: `peer-${i}` }).pipe(
            Effect.timeout("10 seconds"),
            Effect.retry({
              schedule: Schedule.exponential("500 millis"),
              times: 10,
            }),
          ),
        { concurrency: 32 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].greeting).toBe(`hello peer-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(callerUrl)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);
