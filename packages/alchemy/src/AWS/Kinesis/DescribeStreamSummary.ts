import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface DescribeStreamSummaryRequest extends Omit<
  Kinesis.DescribeStreamSummaryInput,
  "StreamName" | "StreamARN"
> {}

/** @binding */
export interface DescribeStreamSummary extends Binding.Service<
  DescribeStreamSummary,
  "AWS.Kinesis.DescribeStreamSummary",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: DescribeStreamSummaryRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamSummaryOutput,
      Kinesis.DescribeStreamSummaryError
    >
  >
> {}

export const DescribeStreamSummary = Binding.Service<DescribeStreamSummary>(
  "AWS.Kinesis.DescribeStreamSummary",
);
