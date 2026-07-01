import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface ListTagsForResourceRequest extends Omit<
  sns.ListTagsForResourceRequest,
  "ResourceArn"
> {}

/** @binding */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.SNS.ListTagsForResource",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      sns.ListTagsForResourceResponse,
      sns.ListTagsForResourceError
    >
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.SNS.ListTagsForResource",
);
