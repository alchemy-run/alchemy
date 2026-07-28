import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
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
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` the Queue resource is emulated (a `dev:` queueId) and
 * the worker's producer binding targets the local broker. The fixture both
 * produces and consumes, so this pins end-to-end local delivery: send over
 * the binding, broker dispatches to the `queue()` handler, poll the
 * recorded bodies back over HTTP.
 */
test.provider(
  "local queue delivers produced messages to the consumer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("LocalQueue");
          const worker = yield* Cloudflare.Worker("queue-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/queue-local-worker.ts",
            ),
            env: { QUEUE: queue },
          });
          yield* Cloudflare.Queues.Consumer("LocalConsumer", {
            queueId: queue.queueId,
            scriptName: worker.workerName,
          });
          return { queue, worker };
        }),
      );

      expect(deployed.queue.queueId).toMatch(/^dev:/);

      const sent = (yield* getJsonReady(
        `${deployed.worker.url}send?text=local-hello`,
      )) as { sent: string };
      expect(sent.sent).toBe("local-hello");

      // Poll until the broker delivers to the fixture's queue() handler.
      const received = yield* getJsonReady(
        `${deployed.worker.url}received`,
      ).pipe(
        Effect.map((body) => (body as { received: string[] }).received),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (received) => received.includes("local-hello"),
          times: 30,
        }),
      );
      expect(received).toContain("local-hello");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.live()` queues cannot be produced to from local dev — a
 * Cloudflare platform limitation, not an alchemy one: remote-binding
 * (edge-preview) sessions do not support queue bindings at all (a preview
 * worker carrying one serves 503 for every request; wrangler has the same
 * gap — cloudflare/workers-sdk#9929). The local worker provider fails the
 * deploy with a descriptive error instead of wiring a binding that breaks
 * on first send. This pins the loud failure.
 */
test.provider(
  "Alchemy.live() queue in dev fails the deploy loudly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const queue = yield* Cloudflare.Queues.Queue("LiveDevQueue").pipe(
              Alchemy.live(),
            );
            const worker = yield* Cloudflare.Worker("queue-live-worker", {
              main: pathe.resolve(
                import.meta.dirname,
                "fixtures/queue-local-worker.ts",
              ),
              env: { QUEUE: queue },
            });
            return { queue, worker };
          }),
        )
        .pipe(Effect.flip);

      expect(String(error)).toContain("live queue");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
