import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export type TaggableResource = Stream | StreamConsumer;

export interface ListTagsForResourceRequest extends Omit<
  Kinesis.ListTagsForResourceInput,
  "ResourceARN"
> {}

/** @binding */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.Kinesis.ListTagsForResource",
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      Kinesis.ListTagsForResourceOutput,
      Kinesis.ListTagsForResourceError
    >
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.Kinesis.ListTagsForResource",
);
