import type * as sqs from "@distilled.cloud/aws/sqs";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { Queue } from "./Queue.ts";

/**
 * A raw `SendMessageBatchRequestEntry` minus the batch-correlation `Id`,
 * which the sink assigns per API call. Callers stay in control of
 * `MessageBody`, `MessageGroupId`, `MessageDeduplicationId`, attributes, etc.
 */
export interface QueueSinkEntry extends Omit<
  sqs.SendMessageBatchRequestEntry,
  "Id"
> {}

export type QueueSinkError =
  | sqs.SendMessageBatchError
  | BatchRetryExhaustedError<QueueSinkEntry>;

/**
 * A batching sink over SQS `SendMessageBatch` (10 entries / 256 KiB per
 * call). Per-entry failures with `SenderFault: false` (throttling, internal
 * errors) are retried on a bounded schedule; `SenderFault: true` failures are
 * permanent and dropped. Exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * @binding
 */
export interface QueueSink extends Binding.Service<
  QueueSink,
  "AWS.SQS.QueueSink",
  (
    queue: Queue,
  ) => Effect.Effect<
    Sink.Sink<void, QueueSinkEntry, readonly QueueSinkEntry[], QueueSinkError>
  >
> {}

export const QueueSink = Binding.Service<QueueSink>("AWS.SQS.QueueSink");
