import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

class WorkerNotReady extends Data.TaggedError("WorkerNotReady") {}

for (const dev of [false, true]) {
  const { test } = Test.make({ providers: Cloudflare.providers(), dev });
  test.provider(
    `${dev ? "local" : "live"} queue retains paused messages across a settings update`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deploy = (deliveryPaused: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const queue = yield* Cloudflare.Queues.Queue("DeliveryQueue", {
                settings: { deliveryPaused },
              });
              const database = yield* Cloudflare.D1.Database("Receipts");
              const worker = yield* Cloudflare.Worker("DeliveryWorker", {
                main: pathe.resolve(
                  import.meta.dirname,
                  "fixtures/queue-settings-worker.ts",
                ),
                env: { QUEUE: queue, DB: database },
              });
              yield* Cloudflare.Queues.Consumer("DeliveryConsumer", {
                queueId: queue.queueId,
                scriptName: worker.workerName,
                settings: { batchSize: 1, maxWaitTimeMs: 1000 },
              });
              return { queue, worker };
            }),
          );
        const initial = yield* deploy(true);
        const client = yield* HttpClient.HttpClient;
        const request = (url: string) =>
          client
            .get(url, {
              headers: { connection: "close", "cache-control": "no-cache" },
            })
            .pipe(
              Effect.flatMap((response) =>
                Effect.gen(function* () {
                  if (response.status !== 200)
                    return yield* Effect.fail(new WorkerNotReady());
                  return yield* response.json;
                }),
              ),
              Effect.retry({
                while: (e) => e._tag === "WorkerNotReady",
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
            );
        const sent = yield* request(
          `${initial.worker.url}/send?text=retained`,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (body) => (body as { sent?: string }).sent === "retained",
          }),
        );
        expect(sent).toEqual({ sent: "retained" });
        yield* Effect.sleep("1500 millis");
        expect(yield* request(`${initial.worker.url}/received`)).toEqual({
          received: [],
        });
        const updated = yield* deploy(false);
        expect(updated.queue.queueId).toBe(initial.queue.queueId);
        const delivered = yield* request(`${updated.worker.url}/received`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
            until: (body) =>
              (body as { received?: string[] }).received?.includes(
                "retained",
              ) === true,
          }),
        );
        expect((delivered as { received: string[] }).received).toContain(
          "retained",
        );
        yield* stack.destroy();
      }),
    { timeout: 90000 },
  );
}
