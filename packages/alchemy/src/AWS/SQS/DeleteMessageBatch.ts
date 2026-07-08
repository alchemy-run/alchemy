import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageBatchRequest extends Omit<
  sqs.DeleteMessageBatchRequest,
  "QueueUrl"
> {}

/** @binding */
export interface DeleteMessageBatch extends Binding.Service<
  DeleteMessageBatch,
  "AWS.SQS.DeleteMessageBatch",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteMessageBatchRequest,
    ) => Effect.Effect<
      sqs.DeleteMessageBatchResult,
      sqs.DeleteMessageBatchError
    >
  >
> {}

export const DeleteMessageBatch = Binding.Service<DeleteMessageBatch>(
  "AWS.SQS.DeleteMessageBatch",
);
