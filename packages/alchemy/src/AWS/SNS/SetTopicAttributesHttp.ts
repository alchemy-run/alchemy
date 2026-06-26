import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  SetTopicAttributes,
  type SetTopicAttributesRequest,
} from "./SetTopicAttributes.ts";
import type { Topic } from "./Topic.ts";

export const SetTopicAttributesHttp = Layer.effect(
  SetTopicAttributes,
  Effect.gen(function* () {
    const setTopicAttributes = yield* sns.setTopicAttributes;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.SetTopicAttributes(${topic}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:SetTopicAttributes"],
                  Resource: [topic.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SNS.SetTopicAttributes(${topic.LogicalId})`)(
        function* (request: SetTopicAttributesRequest) {
          return yield* setTopicAttributes({
            ...request,
            TopicArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
