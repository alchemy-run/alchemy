import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface ReceiveMessageRequest extends Omit<
  sqs.ReceiveMessageRequest,
  "QueueUrl"
> {}

/** @binding */
export interface ReceiveMessage extends Binding.Service<
  ReceiveMessage,
  "AWS.SQS.ReceiveMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: ReceiveMessageRequest,
    ) => Effect.Effect<sqs.ReceiveMessageResult, sqs.ReceiveMessageError>
  >
> {}

export const ReceiveMessage = Binding.Service<ReceiveMessage>(
  "AWS.SQS.ReceiveMessage",
);
