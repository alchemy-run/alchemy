import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { PingRpcs } from "./fixtures/rpc-http/group.ts";
import RpcHttpTestWorker from "./fixtures/rpc-http/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "RpcHttpTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* RpcHttpTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
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
  "RpcServer.toHttpEffect: warmup ping",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(PingRpcs);
        const result = yield* client.Ping({ message: "hello" }).pipe(
          Effect.retry({
            schedule: Schedule.exponential("500 millis"),
            times: 15,
          }),
        );
        expect(result.echo).toBe("hello");
        expect(result.n).toBeGreaterThan(0);
      }),
    ).pipe(Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcServer.toHttpEffect: 200 concurrent calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(PingRpcs);

        const N = 200;
        const results = yield* Effect.forEach(
          Array.from({ length: N }, (_, i) => i),
          (i) =>
            client
              .Ping({ message: `m-${i}` })
              .pipe(Effect.timeout("20 seconds")),
          { concurrency: 64 },
        );

        expect(results).toHaveLength(N);
        for (let i = 0; i < N; i++) {
          expect(results[i].echo).toBe(`m-${i}`);
        }
      }),
    ).pipe(Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "RpcServer.toHttpEffect: slow handler under concurrency does not leak request scope",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(PingRpcs);

        const N = 64;
        const results = yield* Effect.forEach(
          Array.from({ length: N }, (_, i) => i),
          () => client.Slow({ ms: 250 }).pipe(Effect.timeout("30 seconds")),
          { concurrency: N },
        );

        expect(results).toHaveLength(N);
        for (const r of results) expect(r.slept).toBe(250);
      }),
    ).pipe(Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 240_000 },
);
