import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface ListSubscriptionsByTopicRequest extends Omit<
  sns.ListSubscriptionsByTopicInput,
  "TopicArn"
> {}

/** @binding */
export interface ListSubscriptionsByTopic extends Binding.Service<
  ListSubscriptionsByTopic,
  "AWS.SNS.ListSubscriptionsByTopic",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionsByTopicRequest,
    ) => Effect.Effect<
      sns.ListSubscriptionsByTopicResponse,
      sns.ListSubscriptionsByTopicError
    >
  >
> {}
export const ListSubscriptionsByTopic =
  Binding.Service<ListSubscriptionsByTopic>("AWS.SNS.ListSubscriptionsByTopic");
