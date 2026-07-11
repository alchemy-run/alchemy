import type * as sns from "@distilled.cloud/aws/sns";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { Topic } from "./Topic.ts";

/**
 * A raw `PublishBatchRequestEntry` minus the batch-correlation `Id`, which
 * the sink assigns per API call. Callers stay in control of `Message`,
 * `Subject`, `MessageGroupId`, `MessageDeduplicationId`, attributes, etc.
 */
export interface TopicSinkEntry extends Omit<
  sns.PublishBatchRequestEntry,
  "Id"
> {}

export type TopicSinkError =
  | sns.PublishBatchError
  | BatchRetryExhaustedError<TopicSinkEntry>;

/**
 * A batching sink over SNS `PublishBatch` (10 entries / 256 KiB per call).
 * Per-entry failures with `SenderFault: false` (throttling, internal errors)
 * are retried on a bounded schedule; `SenderFault: true` failures are
 * permanent and dropped. Exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * @binding
 */
export interface TopicSink extends Binding.Service<
  TopicSink,
  "AWS.SNS.TopicSink",
  (
    topic: Topic,
  ) => Effect.Effect<
    Sink.Sink<void, TopicSinkEntry, readonly TopicSinkEntry[], TopicSinkError>
  >
> {}

export const TopicSink = Binding.Service<TopicSink>("AWS.SNS.TopicSink");
