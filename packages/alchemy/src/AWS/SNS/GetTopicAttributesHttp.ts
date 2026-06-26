import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetTopicAttributes,
  type GetTopicAttributesRequest,
} from "./GetTopicAttributes.ts";
import type { Topic } from "./Topic.ts";

export const GetTopicAttributesHttp = Layer.effect(
  GetTopicAttributes,
  Effect.gen(function* () {
    const getTopicAttributes = yield* sns.getTopicAttributes;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.GetTopicAttributes(${topic}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:GetTopicAttributes"],
                  Resource: [topic.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SNS.GetTopicAttributes(${topic.LogicalId})`)(
        function* (request?: GetTopicAttributesRequest) {
          return yield* getTopicAttributes({
            ...request,
            TopicArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
