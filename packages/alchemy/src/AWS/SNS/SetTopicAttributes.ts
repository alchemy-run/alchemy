import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface SetTopicAttributesRequest extends Omit<
  sns.SetTopicAttributesInput,
  "TopicArn"
> {}

/** @binding */
export interface SetTopicAttributes extends Binding.Service<
  SetTopicAttributes,
  "AWS.SNS.SetTopicAttributes",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: SetTopicAttributesRequest,
    ) => Effect.Effect<
      sns.SetTopicAttributesResponse,
      sns.SetTopicAttributesError
    >
  >
> {}

export const SetTopicAttributes = Binding.Service<SetTopicAttributes>(
  "AWS.SNS.SetTopicAttributes",
);
