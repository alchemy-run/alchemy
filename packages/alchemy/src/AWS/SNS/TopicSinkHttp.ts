import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import { isFunction } from "../Lambda/Function.ts";
import { PublishBatch } from "./PublishBatch.ts";
import { TopicSink } from "./TopicSink.ts";
import type { Topic } from "./Topic.ts";

export const TopicSinkHttp = Layer.effect(
  TopicSink,
  Effect.gen(function* () {
    const publishBatch = yield* PublishBatch;

    return Effect.fn(function* (topic: Topic) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.TopicSink(${topic}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:Publish"],
                Resource: [topic.topicArn],
              },
            ],
          });
        }
      }
      const publish = yield* publishBatch(topic);

      return Sink.forEachArray((messages: readonly string[]) =>
        publish({
          PublishBatchRequestEntries: messages.map((message, index) => ({
            Id: `${index}`,
            Message: message,
          })),
        }).pipe(Effect.orDie, Effect.asVoid),
      );
    });
  }),
);
