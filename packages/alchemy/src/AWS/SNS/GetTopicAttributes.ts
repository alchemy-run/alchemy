import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface GetTopicAttributesRequest extends Omit<
  sns.GetTopicAttributesInput,
  "TopicArn"
> {}

/** @binding */
export interface GetTopicAttributes extends Binding.Service<
  GetTopicAttributes,
  "AWS.SNS.GetTopicAttributes",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: GetTopicAttributesRequest,
    ) => Effect.Effect<
      sns.GetTopicAttributesResponse,
      sns.GetTopicAttributesError
    >
  >
> {}

export const GetTopicAttributes = Binding.Service<GetTopicAttributes>(
  "AWS.SNS.GetTopicAttributes",
);
