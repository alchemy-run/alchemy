import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListStreamsRequest extends Kinesis.ListStreamsInput {}

/** @binding */
export interface ListStreams extends Binding.Service<
  ListStreams,
  "AWS.Kinesis.ListStreams",
  () => Effect.Effect<
    (
      request?: ListStreamsRequest,
    ) => Effect.Effect<Kinesis.ListStreamsOutput, Kinesis.ListStreamsError>
  >
> {}
export const ListStreams = Binding.Service<ListStreams>(
  "AWS.Kinesis.ListStreams",
);
