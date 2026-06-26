import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { PublishBatch, type PublishBatchRequest } from "./PublishBatch.ts";
import type { Topic } from "./Topic.ts";

export const PublishBatchHttp = Layer.effect(
  PublishBatch,
  Effect.gen(function* () {
    const publishBatch = yield* sns.publishBatch;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.PublishBatch(${topic}))`({
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
      return Effect.fn(`AWS.SNS.PublishBatch(${topic.LogicalId})`)(function* (
        request: PublishBatchRequest,
      ) {
        return yield* publishBatch({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);
