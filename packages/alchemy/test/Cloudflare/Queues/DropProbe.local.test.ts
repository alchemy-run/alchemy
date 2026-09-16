import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { MinimumLogLevel } from "effect/References";
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

// Deploy a producer before its consumer, restart the producer, then attach
// a separate consumer. Successful sends must survive both missing consumers
// and the workerd restart, rather than being acknowledged and discarded.
test.provider(
  "producer-only queue survives restart and delivers to a late consumer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (revision: string, consume: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const queue = yield* Cloudflare.Queues.Queue("BufferedQueue");
            const worker = yield* Cloudflare.Worker("buffered-producer", {
              main: pathe.resolve(
                import.meta.dirname,
                "fixtures/queue-local-worker.ts",
              ),
              env: { QUEUE: queue, REVISION: revision },
            });
            const consumer = consume
              ? yield* Cloudflare.Worker("late-consumer", {
                  main: pathe.resolve(
                    import.meta.dirname,
                    "fixtures/queue-local-worker.ts",
                  ),
                })
              : undefined;
            if (consumer)
              yield* Cloudflare.Queues.Consumer("LateConsumer", {
                queueId: queue.queueId,
                scriptName: consumer.workerName,
                settings: { maxWaitTimeMs: 0 },
              });
            return { queue, worker, consumer };
          }),
        );
      const client = yield* HttpClient.HttpClient;
      const initial = yield* deploy("one", false);
      const response = yield* client
        .get(`${initial.worker.url}/send?text=keep-me`)
        .pipe(Effect.timeout("20 seconds"), Effect.orDie);
      expect(response.status).toBe(200);
      yield* response.text.pipe(Effect.orDie);
      // Let the spool observe the missing registry consumer before restarting.
      yield* Effect.sleep("1500 millis");
      const restarted = yield* deploy("two", false);
      const restartedResponse = yield* client
        .get(`${restarted.worker.url}/plain`)
        .pipe(Effect.orDie);
      expect(restartedResponse.status).toBe(200);
      yield* restartedResponse.text.pipe(Effect.orDie);
      const attached = yield* deploy("two", true);
      const received = yield* client
        .get(`${attached.consumer!.url}/received`)
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { received: string[] }).received),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (received) => received.includes("keep-me"),
          }),
          Effect.orDie,
        );
      expect(received).toContain("keep-me");
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "producer-only queue delivers when its own worker becomes the consumer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (revision: string, consume: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const queue = yield* Cloudflare.Queues.Queue("PromotedQueue");
            const worker = yield* Cloudflare.Worker("promoted-producer", {
              main: pathe.resolve(
                import.meta.dirname,
                "fixtures/queue-local-worker.ts",
              ),
              env: { QUEUE: queue, REVISION: revision },
            });
            const consumer = consume ? worker : undefined;
            if (consumer)
              yield* Cloudflare.Queues.Consumer("LateConsumer", {
                queueId: queue.queueId,
                scriptName: consumer.workerName,
                settings: { maxWaitTimeMs: 0 },
              });
            return { queue, worker, consumer };
          }),
        );
      const client = yield* HttpClient.HttpClient;
      const initial = yield* deploy("one", false);
      const response = yield* client
        .get(`${initial.worker.url}/send?text=keep-me`)
        .pipe(Effect.timeout("20 seconds"), Effect.orDie);
      expect(response.status).toBe(200);
      yield* response.text.pipe(Effect.orDie);
      // Let the spool observe the missing registry consumer before restarting.
      yield* Effect.sleep("1500 millis");
      const restarted = yield* deploy("two", false);
      const restartedResponse = yield* client
        .get(`${restarted.worker.url}/plain`)
        .pipe(Effect.orDie);
      expect(restartedResponse.status).toBe(200);
      yield* restartedResponse.text.pipe(Effect.orDie);
      const attached = yield* deploy("two", true);
      const received = yield* client
        .get(`${attached.consumer!.url}/received`)
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { received: string[] }).received),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (received) => received.includes("keep-me"),
          }),
          Effect.orDie,
        );
      expect(received).toContain("keep-me");
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "destroying a fixed-name queue starts a fresh message lifetime",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const client = yield* HttpClient.HttpClient;
      // Exercise both a producer-only spool and a paused consumer's broker.
      for (const initiallyConsumed of [false, true]) {
        const deploy = (fresh: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const queue = yield* Cloudflare.Queues.Queue("FixedQueue", {
                name: "audit-fixed-lifetime-queue",
                settings: { deliveryPaused: !fresh },
              });
              const worker = yield* Cloudflare.Worker("FixedWorker", {
                name: "audit-fixed-lifetime-worker",
                main: pathe.resolve(
                  import.meta.dirname,
                  "fixtures/queue-local-worker.ts",
                ),
                env: { QUEUE: queue },
              });
              if (fresh || initiallyConsumed)
                yield* Cloudflare.Queues.Consumer("FixedConsumer", {
                  queueId: queue.queueId,
                  scriptName: worker.workerName,
                  settings: { maxWaitTimeMs: 0 },
                });
              return { queue, worker };
            }),
          );
        const initial = yield* deploy(false);
        const stale = yield* client
          .get(`${initial.worker.url}/send?text=stale`)
          .pipe(Effect.orDie);
        expect(stale.status).toBe(200);
        yield* stale.text.pipe(Effect.orDie);
        yield* Effect.sleep("1500 millis");
        yield* stack.destroy();
        const fresh = yield* deploy(true);
        expect(fresh.queue.queueName).toBe(initial.queue.queueName);
        expect(fresh.queue.queueId).not.toBe(initial.queue.queueId);
        expect(fresh.worker.workerName).toBe(initial.worker.workerName);
        const sent = yield* client
          .get(`${fresh.worker.url}/send?text=fresh`)
          .pipe(Effect.orDie);
        expect(sent.status).toBe(200);
        yield* sent.text.pipe(Effect.orDie);
        const received = yield* client.get(`${fresh.worker.url}/received`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { received: string[] }).received),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (received) => received.includes("fresh"),
          }),
          Effect.orDie,
        );
        expect(received).toEqual(["fresh"]);
        yield* stack.destroy();
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);
