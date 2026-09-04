import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SharedGateWorker, {
  type HitResult,
} from "./fixtures/do-shared-gate/worker.ts";

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

interface RaceBody {
  results: ReadonlyArray<HitResult>;
}

/**
 * Pins the Durable Object bridge's IoContext discipline.
 *
 * workerd pins I/O objects (storage, sockets, bodies) to the actor that
 * created them, while Effect fibers wake each other synchronously inside
 * the finisher's task. Any isolate-shared primitive — here an
 * `Effect.cached` gate in the shared layer build, in practice a cached
 * D1 schema ensure or a shared semaphore — therefore resumes every other
 * actor's fiber inside ONE actor's timer callback. Without the bridge
 * re-dispatching a fiber into its own actor's context, every actor but
 * the finisher dies with "Cannot perform I/O on behalf of a different
 * Durable Object (I/O type: ActorCacheInterface)" on its next storage
 * call. The race is run twice: once on a cold isolate (all actors also
 * share the in-flight layer build) and once warm. The same discipline is
 * then checked for the Worker bridge, where the pinned object is the
 * request body of concurrent requests racing through the same gate.
 */
test.provider(
  "fibers woken by a shared fiber still perform I/O in their own IoContext",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* SharedGateWorker;
          return { url: worker.url };
        }),
      );
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const client = yield* HttpClient.HttpClient;
      const race = (count: number) =>
        Effect.gen(function* () {
          const res = yield* client.get(`${deployed.url}/race?count=${count}`);
          if (res.status !== 200) {
            return yield* Effect.fail(
              new WorkerNotReady({ status: res.status }),
            );
          }
          return (yield* res.json) as unknown as RaceBody;
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "WorkerNotReady",
            schedule: Schedule.exponential("500 millis"),
            times: 10,
          }),
        );

      for (const round of [1, 2]) {
        const { results } = yield* race(8);
        expect(results).toHaveLength(8);
        for (const [i, result] of results.entries()) {
          if (!result.ok) {
            throw new Error(
              `round ${round}: racer-${i} failed: ${result.error}`,
            );
          }
          expect(result.n).toBe(i);
          expect(result.boots).toBe(1);
        }
      }

      // The Worker-side twin: concurrent requests race through the same
      // shared gate and then read their own request-pinned body.
      const gated = (i: number) =>
        Effect.gen(function* () {
          const res = yield* client.execute(
            HttpClientRequest.post(`${deployed.url}/gated`).pipe(
              HttpClientRequest.bodyText(`req-${i}`),
            ),
          );
          if (res.status !== 200) {
            throw new Error(
              `request ${i} failed (${res.status}): ${yield* res.text}`,
            );
          }
          return (yield* res.json) as { body: string };
        });
      const bodies = yield* Effect.all(
        Array.from({ length: 6 }, (_, i) => gated(i)),
        { concurrency: "unbounded" },
      );
      expect(bodies.map((b) => b.body)).toEqual(
        Array.from({ length: 6 }, (_, i) => `req-${i}`),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
