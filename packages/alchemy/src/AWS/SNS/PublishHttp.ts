import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { Publish, type PublishRequest } from "./Publish.ts";
import type { Topic } from "./Topic.ts";

export const PublishHttp = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const publish = yield* sns.publish;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.Publish(${topic}))`({
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
      return Effect.fn(`AWS.SNS.Publish(${topic.LogicalId})`)(function* (
        request: PublishRequest,
      ) {
        return yield* publish({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);
