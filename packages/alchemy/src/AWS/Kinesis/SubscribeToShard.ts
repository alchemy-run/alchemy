import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export interface SubscribeToShardRequest extends Omit<
  Kinesis.SubscribeToShardInput,
  "ConsumerARN"
> {}

/** @binding */
export interface SubscribeToShard extends Binding.Service<
  SubscribeToShard,
  "AWS.Kinesis.SubscribeToShard",
  (
    consumer: StreamConsumer,
  ) => Effect.Effect<
    (
      request: SubscribeToShardRequest,
    ) => Effect.Effect<
      Kinesis.SubscribeToShardOutput,
      Kinesis.SubscribeToShardError
    >
  >
> {}

export const SubscribeToShard = Binding.Service<SubscribeToShard>(
  "AWS.Kinesis.SubscribeToShard",
);
