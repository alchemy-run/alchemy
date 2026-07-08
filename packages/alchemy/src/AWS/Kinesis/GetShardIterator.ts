import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetShardIteratorRequest extends Omit<
  Kinesis.GetShardIteratorInput,
  "StreamName" | "StreamARN"
> {}

/** @binding */
export interface GetShardIterator extends Binding.Service<
  GetShardIterator,
  "AWS.Kinesis.GetShardIterator",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: GetShardIteratorRequest,
    ) => Effect.Effect<
      Kinesis.GetShardIteratorOutput,
      Kinesis.GetShardIteratorError
    >
  >
> {}

export const GetShardIterator = Binding.Service<GetShardIterator>(
  "AWS.Kinesis.GetShardIterator",
);
