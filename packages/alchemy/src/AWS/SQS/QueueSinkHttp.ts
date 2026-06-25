import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import { QueueSink } from "./QueueSink.ts";
import { SendMessageBatch } from "./SendMessageBatch.ts";

export const QueueSinkHttp = Layer.effect(
  QueueSink,
  Effect.gen(function* () {
    const sendMessageBatch = yield* SendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SQS.QueueSink(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:SendMessage", "sqs:SendMessageBatch"],
                Resource: [Output.interpolate`${queue.queueArn}`],
              },
            ],
          });
        }
      }
      const sendBatch = yield* sendMessageBatch(queue);
      return Sink.forEachArray((messages: readonly string[]) =>
        sendBatch({
          Entries: messages.map((message, i) => ({
            Id: `${i}`,
            MessageBody: message,
          })),
        }).pipe(Effect.orDie, Effect.asVoid),
      );
    });
  }),
);
