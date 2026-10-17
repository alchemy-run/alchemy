import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import WorkerALive, { WorkerA } from "./fixtures/circular-bindings/workerA.ts";
import WorkerBLive, { WorkerB } from "./fixtures/circular-bindings/workerB.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * GET a route, retrying until the freshly started workerd serves a 200 —
 * including 500s while a peer's dev-registry entry is still propagating.
 */
const getTextReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * WorkerA binds the `Counter` hosted by WorkerB (`Counter.from(WorkerB)`)
 * while WorkerB binds WorkerA (`bindWorker(WorkerA)`). The two Workers are
 * cycle peers, so both are pre-created before either's outputs resolve —
 * WorkerA's pre-creation must not read WorkerB's still-unresolved
 * `workerName` from the cross-script Durable Object binding.
 */
test.provider(
  "Workers in a cycle bind a cross-script Durable Object locally",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const workerA = yield* WorkerA;
          const workerB = yield* WorkerB;
          return {
            urlA: workerA.url.as<string>(),
            urlB: workerB.url.as<string>(),
          };
        }).pipe(Effect.provide(Layer.mergeAll(WorkerALive, WorkerBLive))),
      );

      // Dev markers: both Workers serve from the local dev proxy — no cloud
      // deploy ran.
      expect(deployed.urlA).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.urlB).toMatch(/^http:\/\/localhost:\d+$/);

      // A request through WorkerA increments WorkerB's Counter, and WorkerB
      // reads the same instance from its own namespace.
      const key = crypto.randomUUID();
      expect(JSON.parse(yield* getTextReady(`${deployed.urlA}/?key=${key}`))).toEqual({
        value: 1,
      });
      expect(JSON.parse(yield* getTextReady(`${deployed.urlB}/?key=${key}`))).toEqual({
        value: 1,
      });

      // The other edge of the cycle: WorkerB calls WorkerA.
      expect(yield* getTextReady(`${deployed.urlB}/worker-a`)).toBe("WorkerA");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
