import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface DescribeStreamRequest extends Omit<
  Kinesis.DescribeStreamInput,
  "StreamName" | "StreamARN"
> {}

/** @binding */
export interface DescribeStream extends Binding.Service<
  DescribeStream,
  "AWS.Kinesis.DescribeStream",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: DescribeStreamRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamOutput,
      Kinesis.DescribeStreamError
    >
  >
> {}

export const DescribeStream = Binding.Service<DescribeStream>(
  "AWS.Kinesis.DescribeStream",
);
