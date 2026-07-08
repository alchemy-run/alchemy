import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface PublishBatchRequest extends Omit<
  sns.PublishBatchInput,
  "TopicArn"
> {}

/** @binding */
export interface PublishBatch extends Binding.Service<
  PublishBatch,
  "AWS.SNS.PublishBatch",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishBatchRequest,
    ) => Effect.Effect<sns.PublishBatchResponse, sns.PublishBatchError>
  >
> {}

export const PublishBatch = Binding.Service<PublishBatch>(
  "AWS.SNS.PublishBatch",
);
