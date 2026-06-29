import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TaggableResource } from "./binding-common.ts";

export interface ListTagsForResourceRequest extends Omit<
  cloudwatch.ListTagsForResourceInput,
  "ResourceARN"
> {}

/**
 * Runtime binding for `cloudwatch:ListTagsForResource`.
 * @binding
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.CloudWatch.ListTagsForResource",
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      cloudwatch.ListTagsForResourceOutput,
      cloudwatch.ListTagsForResourceError
    >
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.CloudWatch.ListTagsForResource",
);
