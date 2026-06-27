import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface ListShardsRequest extends Omit<
  Kinesis.ListShardsInput,
  "StreamName" | "StreamARN"
> {}

/** @binding */
export interface ListShards extends Binding.Service<
  ListShards,
  "AWS.Kinesis.ListShards",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: ListShardsRequest,
    ) => Effect.Effect<Kinesis.ListShardsOutput, Kinesis.ListShardsError>
  >
> {}

export const ListShards = Binding.Service<ListShards>("AWS.Kinesis.ListShards");
