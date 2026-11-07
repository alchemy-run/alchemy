import type * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import { PublishBatch } from "./PublishBatch.ts";
import type { Topic } from "./Topic.ts";

/**
 * A raw `PublishBatchRequestEntry` minus the batch-correlation `Id`, which
 * the sink assigns per API call. Callers stay in control of `Message`,
 * `Subject`, `MessageGroupId`, `MessageDeduplicationId`, attributes, etc.
 */
export interface TopicSinkEntry extends Omit<sns.PublishBatchRequestEntry, "Id"> {}

export type TopicSinkError = sns.PublishBatchError | BatchRetryExhaustedError<TopicSinkEntry>;

/**
 * A batching sink over SNS `PublishBatch` (10 entries / 256 KiB per call).
 * Per-entry failures with `SenderFault: false` (throttling, internal errors)
 * are retried on a bounded schedule; `SenderFault: true` failures are
 * permanent and dropped. Exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * The binding grants the host function `sns:Publish` on the topic. Provide
 * the `TopicSinkHttp` layer (which itself needs `PublishBatchHttp`) on the
 * Function to implement the binding.
 * ### Streaming Messages into a Topic
 * **Example:** Run a Stream into a Topic
 * ```typescript
 * // init (provide SNS.TopicSinkHttp + SNS.PublishBatchHttp on the Function)
 * const sink = yield* SNS.TopicSink(topic);
 *
 * // runtime: batching, size limits, and transient-failure retry are handled
 * // by the sink — each element is a PublishBatchRequestEntry minus `Id`.
 * yield* Stream.fromIterable(messages).pipe(
 *   Stream.map((message) => ({ Message: message })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * @binding
 */
export interface TopicSink extends Binding.Service<
  TopicSink,
  "AWS.SNS.TopicSink",
  (
    topic: Topic,
  ) => Effect.Effect<Sink.Sink<void, TopicSinkEntry, readonly TopicSinkEntry[], TopicSinkError>>
> {}

export const TopicSink = Binding.Service<TopicSink>("AWS.SNS.TopicSink");

const encoder = new TextEncoder();

/**
 * Select the original entries referenced by `Failed` results with the given
 * `SenderFault` classification, preserving input order. The sink assigns
 * `Id = String(index)` per call, so failed ids map back positionally.
 */
const selectFailed = (
  failed: readonly sns.BatchResultErrorEntry[] | undefined,
  batch: readonly TopicSinkEntry[],
  senderFault: boolean,
): readonly TopicSinkEntry[] => {
  if (failed === undefined || failed.length === 0) {
    return [];
  }
  const indices = new Set(
    failed.filter((entry) => entry.SenderFault === senderFault).map((entry) => Number(entry.Id)),
  );
  return batch.filter((_, index) => indices.has(index));
};

export const TopicSinkHttp = Layer.effect(
  TopicSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const publishBatch = yield* PublishBatch;

    return Effect.fn(function* (topic: Topic) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SNS.TopicSink(${topic})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sns:Publish"],
              Resource: [topic.topicArn],
            },
          ],
        });
      }
      const publish = yield* publishBatch(topic);

      return makeBatchedSink<TopicSinkEntry, sns.PublishBatchResponse, sns.PublishBatchError>({
        maxRecords: 10,
        maxBytes: 262_144,
        sizeOf: (entry) => encoder.encode(entry.Message).length,
        send: (batch) =>
          publish({
            PublishBatchRequestEntries: batch.map((entry, index) => ({
              ...entry,
              Id: `${index}`,
            })),
          }),
        // SenderFault=false failures (throttling, internal errors) are
        // transient — re-submit them on the bounded schedule.
        unprocessed: (out, batch) => selectFailed(out.Failed, batch, false),
        // SenderFault=true failures are permanent — drop and surface.
        rejected: (out, batch) => selectFailed(out.Failed, batch, true),
      });
    });
  }),
);
