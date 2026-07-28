import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` the KV Namespace resource is emulated by the local
 * provider (a `dev:` id, no cloud API calls) and the worker's `kv_namespace`
 * binding is lowered onto the local workerd KV simulator. This exercises the
 * full local roundtrip: put / get / list / delete through the native `env`
 * binding.
 */
test.provider(
  "KV namespace binding round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const kv = yield* Cloudflare.KV.Namespace("LocalKV");
          const worker = yield* Cloudflare.Worker("kv-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/kv-local-worker.ts",
            ),
            env: { KV: kv },
          });
          return { kv, worker };
        }),
      );

      // The local provider fabricates a `dev:` id — proof no cloud call ran.
      expect(deployed.kv.namespaceId).toMatch(/^dev:/);

      const body = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip`,
      )) as {
        value: string;
        value2: string;
        metadata: { hello: string };
        keys: string[];
        afterDelete: string | null;
      };
      expect(body.value).toBe("value1");
      expect(body.value2).toBe("value2");
      expect(body.metadata).toEqual({ hello: "world" });
      expect(body.keys.sort()).toEqual(["key1", "key2"]);
      expect(body.afterDelete).toBeNull();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
