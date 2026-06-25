import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest extends Omit<
  Kinesis.PutRecordInput,
  "StreamName"
> {}

/** @binding */
export interface PutRecord extends Binding.Service<
  PutRecord,
  "AWS.Kinesis.PutRecord",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<Kinesis.PutRecordOutput, Kinesis.PutRecordError>
  >
> {}

export const PutRecord = Binding.Service<PutRecord>("AWS.Kinesis.PutRecord");
