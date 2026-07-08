import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordsRequest extends Omit<
  Kinesis.PutRecordsInput,
  "StreamName"
> {}

/** @binding */
export interface PutRecords extends Binding.Service<
  PutRecords,
  "AWS.Kinesis.PutRecords",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordsRequest,
    ) => Effect.Effect<Kinesis.PutRecordsOutput, Kinesis.PutRecordsError>
  >
> {}

export const PutRecords = Binding.Service<PutRecords>("AWS.Kinesis.PutRecords");
