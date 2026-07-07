import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface UntagResourceRequest extends Omit<
  sns.UntagResourceRequest,
  "ResourceArn"
> {}

/** @binding */
export interface UntagResource extends Binding.Service<
  UntagResource,
  "AWS.SNS.UntagResource",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: UntagResourceRequest,
    ) => Effect.Effect<sns.UntagResourceResponse, sns.UntagResourceError>
  >
> {}
export const UntagResource = Binding.Service<UntagResource>(
  "AWS.SNS.UntagResource",
);
