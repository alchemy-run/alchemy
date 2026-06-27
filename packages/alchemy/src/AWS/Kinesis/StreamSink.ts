import * as Kinesis from "@distilled.cloud/aws/kinesis";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export type StreamSinkRecord = Kinesis.PutRecordsRequestEntry;

/**
 * A partition-aware sink for batching `PutRecords` requests into a stream.
 *
 * Each input element is a raw `PutRecordsRequestEntry`, so callers stay in
 * control of `PartitionKey` and optional `ExplicitHashKey`.
 *
 * @binding
 */
export interface StreamSink extends Binding.Service<
  StreamSink,
  "AWS.Kinesis.StreamSink",
  (
    stream: Stream,
  ) => Effect.Effect<
    Sink.Sink<void, StreamSinkRecord, readonly StreamSinkRecord[], never>
  >
> {}

export const StreamSink = Binding.Service<StreamSink>("AWS.Kinesis.StreamSink");
