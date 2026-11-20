import type * as sqs from "@distilled.cloud/aws/sqs";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import type { Queue } from "./Queue.ts";
import { SendMessageBatch } from "./SendMessageBatch.ts";

/**
 * A raw `SendMessageBatchRequestEntry` minus the batch-correlation `Id`,
 * which the sink assigns per API call. Callers stay in control of
 * `MessageBody`, `MessageGroupId`, `MessageDeduplicationId`, attributes, etc.
 */
export interface QueueSinkEntry extends Omit<sqs.SendMessageBatchRequestEntry, "Id"> {}

export type QueueSinkError = sqs.SendMessageBatchError | BatchRetryExhaustedError<QueueSinkEntry>;

/**
 * A batching sink over SQS `SendMessageBatch` (10 entries / 256 KiB per
 * call). Per-entry failures with `SenderFault: false` (throttling, internal
 * errors) are retried on a bounded schedule; `SenderFault: true` failures are
 * permanent and dropped. Exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * The binding grants the host function `sqs:SendMessage` and
 * `sqs:SendMessageBatch` on the queue. Provide the `QueueSinkHttp` layer
 * (which itself needs `SendMessageBatchHttp`) on the Function to implement
 * the binding.
 * ### Streaming Messages into a Queue
 * **Example:** Run a Stream into a Queue
 * ```typescript
 * // init (provide SQS.QueueSinkHttp + SQS.SendMessageBatchHttp on the Function)
 * const sink = yield* SQS.QueueSink(queue);
 *
 * // runtime: batching, size limits, and transient-failure retry are handled
 * // by the sink — each element is a SendMessageBatchRequestEntry minus `Id`.
 * yield* Stream.fromIterable(messages).pipe(
 *   Stream.map((message) => ({ MessageBody: message })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * **Example:** Forward Event-Source Records into a Result Queue
 * ```typescript
 * const sink = yield* SQS.QueueSink(resultQueue);
 *
 * yield* SQS.consumeQueueMessages(
 *   sourceQueue,
 *   Effect.fn(function* (event) {
 *     yield* Stream.fromIterable(event.Records).pipe(
 *       Stream.map((record) => ({ MessageBody: record.body })),
 *       Stream.run(sink),
 *     );
 *   }),
 * );
 * ```
 *
 * @binding
 */
export interface QueueSink extends Binding.Service<
  QueueSink,
  "AWS.SQS.QueueSink",
  (
    queue: Queue,
  ) => Effect.Effect<Sink.Sink<void, QueueSinkEntry, readonly QueueSinkEntry[], QueueSinkError>>
> {}

export const QueueSink = Binding.Service<QueueSink>("AWS.SQS.QueueSink");

const encoder = new TextEncoder();

/**
 * Select the original entries referenced by `Failed` results with the given
 * `SenderFault` classification, preserving input order. The sink assigns
 * `Id = String(index)` per call, so failed ids map back positionally.
 */
const selectFailed = (
  failed: readonly sqs.BatchResultErrorEntry[] | undefined,
  batch: readonly QueueSinkEntry[],
  senderFault: boolean,
): readonly QueueSinkEntry[] => {
  if (failed === undefined || failed.length === 0) {
    return [];
  }
  const indices = new Set(
    failed.filter((entry) => entry.SenderFault === senderFault).map((entry) => Number(entry.Id)),
  );
  return batch.filter((_, index) => indices.has(index));
};

export const QueueSinkHttp = Layer.effect(
  QueueSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const sendMessageBatch = yield* SendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SQS.QueueSink(${queue})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage", "sqs:SendMessageBatch"],
              Resource: [Output.interpolate`${queue.queueArn}`],
            },
          ],
        });
      }
      const sendBatch = yield* sendMessageBatch(queue);
      return makeBatchedSink<QueueSinkEntry, sqs.SendMessageBatchResult, sqs.SendMessageBatchError>(
        {
          maxRecords: 10,
          maxBytes: 262_144,
          sizeOf: (entry) => encoder.encode(entry.MessageBody).length,
          send: (batch) =>
            sendBatch({
              Entries: batch.map((entry, index) => ({
                ...entry,
                Id: `${index}`,
              })),
            }),
          // SenderFault=false failures (throttling, internal errors) are
          // transient — re-submit them on the bounded schedule.
          unprocessed: (out, batch) => selectFailed(out.Failed, batch, false),
          // SenderFault=true failures are permanent — drop and surface.
          rejected: (out, batch) => selectFailed(out.Failed, batch, true),
        },
      );
    });
  }),
);
