import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageRequest extends Omit<
  sqs.DeleteMessageRequest,
  "QueueUrl"
> {}

/** @binding */
export interface DeleteMessage extends Binding.Service<
  DeleteMessage,
  "AWS.SQS.DeleteMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteMessageRequest,
    ) => Effect.Effect<sqs.DeleteMessageResponse, sqs.DeleteMessageError>
  >
> {}

export const DeleteMessage = Binding.Service<DeleteMessage>(
  "AWS.SQS.DeleteMessage",
);
