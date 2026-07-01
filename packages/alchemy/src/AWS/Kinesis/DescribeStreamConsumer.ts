import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export interface DescribeStreamConsumerRequest extends Omit<
  Kinesis.DescribeStreamConsumerInput,
  "ConsumerARN" | "StreamARN" | "ConsumerName"
> {}

/** @binding */
export interface DescribeStreamConsumer extends Binding.Service<
  DescribeStreamConsumer,
  "AWS.Kinesis.DescribeStreamConsumer",
  (
    consumer: StreamConsumer,
  ) => Effect.Effect<
    (
      request?: DescribeStreamConsumerRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamConsumerOutput,
      Kinesis.DescribeStreamConsumerError
    >
  >
> {}

export const DescribeStreamConsumer = Binding.Service<DescribeStreamConsumer>(
  "AWS.Kinesis.DescribeStreamConsumer",
);
