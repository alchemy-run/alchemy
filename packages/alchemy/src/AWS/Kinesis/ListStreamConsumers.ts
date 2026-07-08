import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface ListStreamConsumersRequest extends Omit<
  Kinesis.ListStreamConsumersInput,
  "StreamARN"
> {}

/** @binding */
export interface ListStreamConsumers extends Binding.Service<
  ListStreamConsumers,
  "AWS.Kinesis.ListStreamConsumers",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: ListStreamConsumersRequest,
    ) => Effect.Effect<
      Kinesis.ListStreamConsumersOutput,
      Kinesis.ListStreamConsumersError
    >
  >
> {}

export const ListStreamConsumers = Binding.Service<ListStreamConsumers>(
  "AWS.Kinesis.ListStreamConsumers",
);
