import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface TagResourceRequest extends Omit<
  sns.TagResourceRequest,
  "ResourceArn"
> {}

/** @binding */
export interface TagResource extends Binding.Service<
  TagResource,
  "AWS.SNS.TagResource",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: TagResourceRequest,
    ) => Effect.Effect<sns.TagResourceResponse, sns.TagResourceError>
  >
> {}

export const TagResource = Binding.Service<TagResource>("AWS.SNS.TagResource");
