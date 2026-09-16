import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import * as Queue from "../../bindings/queue/Queue.ts";
import {
  localRuntimeLayer,
  poll,
  startTestWorker,
} from "../helpers/runtime.ts";

const content = readFileSync(
  new URL("../fixtures/queues/buffering.js", import.meta.url),
  "utf8",
);
const worker = (name: string) => ({
  name,
  compatibilityDate: "2024-11-20",
  compatibilityFlags: [],
  modules: [{ name: "main.js", type: "ESModule" as const, content }],
});
type Message = { body: string; attempts: number; timestamp: string };

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Queue offline buffering",
  (it) => {
    it.effect(
      "producer delay is applied once and zero overrides it",
      () =>
        Effect.gen(function* () {
          const producer = yield* startTestWorker({
            ...worker("delayed-offline-producer"),
            bindings: [
              Queue.local({
                binding: "QUEUE",
                queueName: "delayed-offline",
                deliveryDelay: 3,
              }),
            ],
          });
          const consumer = yield* startTestWorker({
            ...worker("delayed-offline-consumer"),
            bindings: [],
            queueConsumers: [
              {
                queueName: "delayed-offline",
                deliveryDelay: 30,
                maxBatchTimeout: 0,
              },
            ],
          });
          yield* producer.fetch("/", {
            method: "POST",
            body: JSON.stringify({ body: "delayed" }),
          });
          yield* producer.fetch("/", {
            method: "POST",
            body: JSON.stringify({
              body: "immediate",
              options: { delaySeconds: 0 },
            }),
          });
          const immediate = yield* poll<Message[]>(consumer, "/", (messages) =>
            messages.some((m) => m.body === "immediate"),
          );
          expect(immediate.map((m) => m.body)).toEqual(["immediate"]);
          const complete = yield* poll<Message[]>(
            consumer,
            "/",
            (messages) => messages.length === 2,
          );
          expect(complete.map((m) => m.body)).toEqual(["immediate", "delayed"]);
          expect(complete.every((m) => m.attempts === 1)).toBe(true);
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "retention expires offline messages before a consumer registers",
      () =>
        Effect.gen(function* () {
          const producer = yield* startTestWorker({
            ...worker("expiring-offline-producer"),
            bindings: [
              Queue.local({
                binding: "QUEUE",
                queueName: "expiring-offline",
                messageRetentionPeriod: 2,
              }),
            ],
          });
          yield* producer.fetch("/", {
            method: "POST",
            body: JSON.stringify({ body: "expired" }),
          });
          yield* Effect.sleep("3200 millis");
          const consumer = yield* startTestWorker({
            ...worker("expiring-offline-consumer"),
            bindings: [],
            queueConsumers: [
              { queueName: "expiring-offline", maxBatchTimeout: 0 },
            ],
          });
          yield* producer.fetch("/", {
            method: "POST",
            body: JSON.stringify({ body: "fresh" }),
          });
          const complete = yield* poll<Message[]>(consumer, "/", (messages) =>
            messages.some((m) => m.body === "fresh"),
          );
          expect(complete.map((m) => m.body)).toEqual(["fresh"]);
        }),
      { timeout: 30_000 },
    );
  },
);
