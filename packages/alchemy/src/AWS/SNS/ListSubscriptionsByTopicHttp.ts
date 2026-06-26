import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";
import {
  ListSubscriptionsByTopic,
  type ListSubscriptionsByTopicRequest,
} from "./ListSubscriptionsByTopic.ts";

export const ListSubscriptionsByTopicHttp = Layer.effect(
  ListSubscriptionsByTopic,
  Effect.gen(function* () {
    const listSubscriptionsByTopic = yield* sns.listSubscriptionsByTopic;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.ListSubscriptionsByTopic(${topic}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:ListSubscriptionsByTopic"],
                  Resource: [topic.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SNS.ListSubscriptionsByTopic(${topic.LogicalId})`)(
        function* (request?: ListSubscriptionsByTopicRequest) {
          return yield* listSubscriptionsByTopic({
            ...request,
            TopicArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
