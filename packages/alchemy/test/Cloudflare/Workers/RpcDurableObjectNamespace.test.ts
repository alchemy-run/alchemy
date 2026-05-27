import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import Stack from "./fixtures/rpc-do-namespace-do-rpc/stack.ts";
import { WorkerRpcs as RpcWorkerWorkerRpcs } from "./fixtures/rpc-worker-rpc-http/group.ts";
import RpcWorkerStack from "./fixtures/rpc-worker-rpc-http/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const rpcWorkerStack = beforeAll(deploy(RpcWorkerStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(RpcWorkerStack));

// Cap exponential backoff at 3s so retries stay bounded when CF edge is
// slow (otherwise the geometric blow-up dominates wall time).
const readinessSchedule = Schedule.exponential("500 millis").pipe(
  Schedule.either(Schedule.spaced("3 seconds")),
);

// Suffix DO instance ids with a per-process random tag so reruns under
// `NO_DESTROY=1` don't collide with persisted state from earlier runs
// (the DO's `count` lives in `state.storage`).
const runId = Math.random().toString(36).slice(2, 10);
const k = (name: string) => `${name}-${runId}`;

const resetCounter = (url: string, id: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* client
      .post(`${url}/counter/${id}/reset`)
      .pipe(Effect.retry({ schedule: readinessSchedule, times: 10 }));
  });

const rpcClientLayer = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.ndjson),
    ),
  );

test(
  "RpcDurableObjectNamespace: Increment / Get round-trip via Worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const alpha = k("alpha");
    yield* resetCounter(url, alpha);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const incRes = yield* client.post(`${url}/counter/${alpha}/increment`);
    expect(incRes.status).toBe(200);
    const inc = (yield* incRes.json) as { count: number };
    expect(inc.count).toBe(1);

    yield* client.post(`${url}/counter/${alpha}/increment`);
    yield* client.post(`${url}/counter/${alpha}/increment`);

    const getRes = yield* client.get(`${url}/counter/${alpha}`);
    expect(getRes.status).toBe(200);
    const got = (yield* getRes.json) as { count: number };
    expect(got.count).toBe(3);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcDurableObjectNamespace: separate getByName(id) instances are isolated",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const betaId = k("beta");
    const gammaId = k("gamma");
    yield* resetCounter(url, betaId);
    yield* resetCounter(url, gammaId);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    yield* client.post(`${url}/counter/${betaId}/increment`);

    const beta = (yield* (yield* client.get(`${url}/counter/${betaId}`))
      .json) as {
      count: number;
    };
    const gamma = (yield* (yield* client.get(`${url}/counter/${gammaId}`))
      .json) as {
      count: number;
    };
    expect(beta.count).toBe(1);
    expect(gamma.count).toBe(0);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcDurableObjectNamespace: streaming RPC via getByName(id).CountUpTo",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const delta = k("delta");
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${url}/counter/${delta}/stream?upto=4`)
      .pipe(Effect.retry({ times: 5 }));
    expect(res.status).toBe(200);
    const body = yield* res.text;
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual(["1", "2", "3", "4"]);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcWorker + RpcDurableObjectNamespace: Worker proxies *DO RPCs through the typed namespace",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);
      const ping = yield* c
        .Ping({ message: "hi" })
        .pipe(Effect.retry({ times: 5 }));
      expect(ping.echo).toBe("hi");

      const pingDO = yield* c
        .PingDO({ message: "via DO" })
        .pipe(Effect.retry({ times: 5 }));
      expect(pingDO.echo).toBe("via DO");
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcDurableObjectNamespace: 100 concurrent Increment calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const concurrent = k("concurrent");
    yield* resetCounter(url, concurrent);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    yield* client.post(`${url}/counter/${concurrent}/increment`);

    const N = 100;
    const results = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      () =>
        client.post(`${url}/counter/${concurrent}/increment`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.timeout("10 seconds"),
          Effect.retry({
            schedule: readinessSchedule,
            times: 3,
          }),
        ),
      { concurrency: 32 },
    );

    expect(results).toHaveLength(N);
    const finalRes = yield* client.get(`${url}/counter/${concurrent}`);
    const final = (yield* finalRes.json) as { count: number };
    expect(final.count).toBe(N + 1);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcWorker + RpcDurableObjectNamespace: 100 concurrent unary RPCs do not hang",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          c.Ping({ message: `m-${i}` }).pipe(
            Effect.timeout("10 seconds"),
            Effect.retry({
              schedule: readinessSchedule,
              times: 3,
            }),
          ),
        { concurrency: 32 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcWorker + RpcDurableObjectNamespace: 100 concurrent *DO unary RPCs do not hang",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          c.PingDO({ message: `m-${i}` }).pipe(
            Effect.timeout("10 seconds"),
            Effect.retry({
              schedule: readinessSchedule,
              times: 3,
            }),
          ),
        { concurrency: 16 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "RpcWorker + RpcDurableObjectNamespace: 100 concurrent streaming *DO RPCs do not hang",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          c.CountDO({ upto: 3 + (i % 3) }).pipe(
            Stream.runCollect,
            Effect.timeout("10 seconds"),
            Effect.retry({
              schedule: readinessSchedule,
              times: 3,
            }),
          ),
        { concurrency: 16 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i]).toEqual(
          Array.from({ length: 3 + (i % 3) }, (_, n) => n + 1),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);
