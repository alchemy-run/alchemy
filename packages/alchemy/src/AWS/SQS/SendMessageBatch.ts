import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageBatchRequest extends Omit<
  sqs.SendMessageBatchRequest,
  "QueueUrl"
> {}

/** @binding */
export interface SendMessageBatch extends Binding.Service<
  SendMessageBatch,
  "AWS.SQS.SendMessageBatch",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageBatchRequest,
    ) => Effect.Effect<sqs.SendMessageBatchResult, sqs.SendMessageBatchError>
  >
> {}

export const SendMessageBatch = Binding.Service<SendMessageBatch>(
  "AWS.SQS.SendMessageBatch",
);
