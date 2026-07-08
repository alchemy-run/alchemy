import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageRequest extends Omit<
  sqs.SendMessageRequest,
  "QueueUrl"
> {}

/** @binding */
export interface SendMessage extends Binding.Service<
  SendMessage,
  "AWS.SQS.SendMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageRequest,
    ) => Effect.Effect<sqs.SendMessageResult, sqs.SendMessageError>
  >
> {}

export const SendMessage = Binding.Service<SendMessage>("AWS.SQS.SendMessage");
