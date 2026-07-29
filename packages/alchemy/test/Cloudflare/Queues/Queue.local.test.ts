import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
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
        `${deployed.worker.url}/send?text=local-hello`,
      )) as { sent: string };
      expect(sent.sent).toBe("local-hello");

      // Poll until the broker delivers to the fixture's queue() handler.
      const received = yield* getJsonReady(
        `${deployed.worker.url}/received`,
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
 * The full `Alchemy.live()` queue roundtrip in dev: the local worker
 * produces through the deployed shim into the REAL queue, and its local
 * `queue()` handler receives the messages back through the runtime's pull
 * loop (the Consumer's local provider attaches an `http_pull` consumer to
 * the real queue; the pull loop drains it into the local broker).
 */
test.provider(
  "Alchemy.live() queue round-trips: local produce, real queue, local consume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue(
            "LiveRoundtripQueue",
          ).pipe(Alchemy.live());
          const worker = yield* Cloudflare.Worker("queue-roundtrip-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/queue-local-worker.ts",
            ),
            env: { QUEUE: queue },
          });
          yield* Cloudflare.Queues.Consumer("LiveRoundtripConsumer", {
            queueId: queue.queueId,
            scriptName: worker.workerName,
          });
          return { queue, worker };
        }),
      );

      // The queue is real; the worker (and its queue() handler) is local.
      expect(deployed.queue.queueId).not.toMatch(/^dev:/);

      // Produce through the shim into the real queue.
      const sent = (yield* getJsonReady(
        `${deployed.worker.url}/send?text=roundtrip-hello`,
      )) as { sent: string };
      expect(sent.sent).toBe("roundtrip-hello");

      // The pull loop drains the real queue into the local broker, which
      // delivers to the fixture's queue() handler.
      const received = yield* getJsonReady(
        `${deployed.worker.url}/received`,
      ).pipe(
        Effect.map((body) => (body as { received: string[] }).received),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (received) => received.includes("roundtrip-hello"),
          times: 30,
        }),
      );
      expect(received).toContain("roundtrip-hello");

      yield* stack.destroy();

      // Destroy removed the real queue (with its pull consumer and shim).
      const { accountId } = yield* yield* CloudflareEnvironment;
      const gone = yield* queues
        .getQueue({ accountId, queueId: deployed.queue.queueId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

/**
 * `Alchemy.live()` queues in dev: Cloudflare's remote-binding (preview)
 * sessions reject queue bindings at the platform level
 * (cloudflare/workers-sdk#9929), so production goes through the deployed
 * shim instead — the eval registers a real shim worker holding the actual
 * queue binding, and the local worker's producer binding relays the queue
 * wire protocol to it over HTTPS with a minted bearer token.
 *
 * The proof is out-of-band: an `http_pull` consumer attached directly via
 * the cloud API pulls the messages back from the REAL queue.
 */
test.provider(
  "Alchemy.live() queue in dev produces through the deployed shim",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
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
      );

      // The queue is real (live provider), the worker is local.
      expect(deployed.queue.queueId).not.toMatch(/^dev:/);
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Out-of-band http_pull consumer so the test can pull from the real
      // queue (a local queue() handler cannot receive from a live queue —
      // Cloudflare pushes to deployed consumers only).
      yield* queues.createConsumer({
        accountId,
        queueId: deployed.queue.queueId,
        type: "http_pull",
      });

      // Produce through the local worker: binding → forwarder → shim →
      // queue. The first send rides out the shim's workers.dev propagation
      // (the forwarder retries 404/503 internally; the outer retry covers
      // the tail).
      const sent = (yield* getJsonReady(
        `${deployed.worker.url}/send?text=live-hello`,
      )) as { sent: string };
      expect(sent.sent).toBe("live-hello");
      const batch = (yield* getJsonReady(
        `${deployed.worker.url}/sendbatch?text=live-batch`,
      )) as { sent: number };
      expect(batch.sent).toBe(2);

      // Pull the messages back from the REAL queue. Pulled messages are
      // leased (invisible to subsequent pulls until the timeout), so
      // accumulate bodies across pulls instead of expecting one batch to
      // carry everything.
      const seen = new Set<string>();
      const bodies = yield* queues
        .pullMessage({
          accountId,
          queueId: deployed.queue.queueId,
          batchSize: 10,
          visibilityTimeoutMs: 1000,
        })
        .pipe(
          Effect.map((res) => {
            for (const m of res.messages ?? []) {
              seen.add(String(m.body ?? ""));
            }
            return Array.from(seen);
          }),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (bodies) =>
              bodies.some((b) => b.includes("live-hello")) &&
              bodies.some((b) => b.includes("live-batch-a")) &&
              bodies.some((b) => b.includes("live-batch")),
            times: 20,
          }),
        );
      expect(bodies.some((b) => b.includes("live-hello"))).toBe(true);
      expect(bodies.some((b) => b.includes("live-batch-a"))).toBe(true);

      yield* stack.destroy();

      // Destroy removed the real queue (and with it the shim + consumer).
      const gone = yield* queues
        .getQueue({ accountId, queueId: deployed.queue.queueId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
