import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetRecordsRequest extends Kinesis.GetRecordsInput {}

/** @binding */
export interface GetRecords extends Binding.Service<
  GetRecords,
  "AWS.Kinesis.GetRecords",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: GetRecordsRequest,
    ) => Effect.Effect<Kinesis.GetRecordsOutput, Kinesis.GetRecordsError>
  >
> {}

export const GetRecords = Binding.Service<GetRecords>("AWS.Kinesis.GetRecords");
