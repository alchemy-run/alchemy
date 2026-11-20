import type * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Binding from "alchemy/Binding";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import { PutRecords } from "./PutRecords.ts";
import type { Stream } from "./Stream.ts";

export type StreamSinkRecord = Kinesis.PutRecordsRequestEntry;

export type StreamSinkError = Kinesis.PutRecordsError | BatchRetryExhaustedError<StreamSinkRecord>;

/**
 * A partition-aware sink for batching `PutRecords` requests into a stream
 * (500 records / 5 MiB per call).
 *
 * Each input element is a raw `PutRecordsRequestEntry`, so callers stay in
 * control of `PartitionKey` and optional `ExplicitHashKey`.
 *
 * Records the API reports as failed (`FailedRecordCount > 0`, per-record
 * `ErrorCode` — throughput exceeded or internal failure) are re-submitted on
 * a bounded schedule; exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded records.
 *
 * Provide the implementation with `Effect.provide(AWS.Kinesis.StreamSinkHttp)`.
 * ### Writing Streams of Records
 * **Example:** Run an Effect Stream into a Kinesis Stream
 * ```typescript
 * // init — bind the sink to the stream
 * const sink = yield* AWS.Kinesis.StreamSink(stream);
 *
 * // runtime — batches into PutRecords calls of up to 500 records / 5 MiB
 * yield* Stream.fromIterable(
 *   orders.map((order) => ({
 *     PartitionKey: order.id,
 *     Data: new TextEncoder().encode(JSON.stringify(order)),
 *   })),
 * ).pipe(Stream.run(sink));
 * ```
 *
 * @binding
 */
export interface StreamSink extends Binding.Service<
  StreamSink,
  "AWS.Kinesis.StreamSink",
  (
    stream: Stream,
  ) => Effect.Effect<
    Sink.Sink<void, StreamSinkRecord, readonly StreamSinkRecord[], StreamSinkError>
  >
> {}

export const StreamSink = Binding.Service<StreamSink>("AWS.Kinesis.StreamSink");

const encoder = new TextEncoder();

export const StreamSinkHttp = Layer.effect(
  StreamSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putRecords = yield* PutRecords;

    return Effect.fn(function* (stream: Stream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Kinesis.StreamSink(${stream})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["kinesis:PutRecords"],
              Resource: [stream.streamArn],
            },
          ],
        });
      }
      const publish = yield* putRecords(stream);
      return makeBatchedSink<StreamSinkRecord, Kinesis.PutRecordsOutput, Kinesis.PutRecordsError>({
        maxRecords: 500,
        maxBytes: 5 * 1024 * 1024,
        sizeOf: (record) => record.Data.length + encoder.encode(record.PartitionKey).length,
        send: (batch) => publish({ Records: [...batch] }),
        // PutRecords failures are positional: Records[i] mirrors the request
        // order and carries an ErrorCode (throughput exceeded / internal
        // failure) — all transient, so re-submit them on the bounded schedule.
        unprocessed: (out, batch) => {
          if (!out.FailedRecordCount) {
            return [];
          }
          return batch.filter((_, index) => out.Records[index]?.ErrorCode !== undefined);
        },
      });
    });
  }),
);
