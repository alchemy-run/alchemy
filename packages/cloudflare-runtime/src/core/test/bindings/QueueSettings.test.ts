import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "../../bindings/queue/Queue.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const script = `
const messages = [];
export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      const { body, options } = await request.json();
      await env.QUEUE.send(body, options);
    }
    return Response.json(messages);
  },
  async queue(batch) { messages.push(...batch.messages.map(message => message.body)); }
};`;

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Queue-wide settings",
  (it) => {
    it.effect("paused queues accept messages without delivering", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          name: "paused-queue",
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          bindings: [Queue.local({ binding: "QUEUE", queueName: "paused" })],
          queueConsumers: [
            { queueName: "paused", deliveryPaused: true, maxBatchTimeout: 0 },
          ],
        });
        const response = yield* worker.fetch("/", {
          method: "POST",
          body: JSON.stringify({ body: "pending" }),
        });
        expect(response.status).toBe(200);
        yield* Effect.sleep("100 millis");
        const received = yield* worker
          .fetch("/")
          .pipe(
            Effect.flatMap((response) => Effect.promise(() => response.json())),
          );
        expect(received).toEqual([]);
      }),
    );

    it.effect(
      "queue delay is the default and per-message zero overrides it",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            name: "delayed-queue",
            modules: [{ name: "main.js", type: "ESModule", content: script }],
            bindings: [Queue.local({ binding: "QUEUE", queueName: "delayed" })],
            queueConsumers: [
              { queueName: "delayed", deliveryDelay: 1, maxBatchTimeout: 0 },
            ],
          });
          yield* worker.fetch("/", {
            method: "POST",
            body: JSON.stringify({ body: "later" }),
          });
          yield* worker.fetch("/", {
            method: "POST",
            body: JSON.stringify({ body: "now", options: { delaySeconds: 0 } }),
          });
          yield* Effect.sleep("100 millis");
          const get = () =>
            worker
              .fetch("/")
              .pipe(
                Effect.flatMap((response) =>
                  Effect.promise(() => response.json()),
                ),
              );
          expect(yield* get()).toEqual(["now"]);
          yield* Effect.sleep("1100 millis");
          expect(yield* get()).toEqual(["now", "later"]);
        }),
    );

    it.effect(
      "messages expiring during their delivery delay are discarded",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            name: "retention-queue",
            modules: [{ name: "main.js", type: "ESModule", content: script }],
            bindings: [
              Queue.local({ binding: "QUEUE", queueName: "retention" }),
            ],
            queueConsumers: [
              {
                queueName: "retention",
                deliveryDelay: 2,
                messageRetentionPeriod: 1,
                maxBatchTimeout: 0,
              },
            ],
          });
          yield* worker.fetch("/", {
            method: "POST",
            body: JSON.stringify({ body: "expired" }),
          });
          yield* Effect.sleep("2200 millis");
          const received = yield* worker
            .fetch("/")
            .pipe(
              Effect.flatMap((response) =>
                Effect.promise(() => response.json()),
              ),
            );
          expect(received).toEqual([]);
        }),
    );
  },
);
