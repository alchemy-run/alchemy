import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface RemovePermissionRequest extends Omit<
  sns.RemovePermissionInput,
  "TopicArn"
> {}

/** @binding */
export interface RemovePermission extends Binding.Service<
  RemovePermission,
  "AWS.SNS.RemovePermission",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: RemovePermissionRequest,
    ) => Effect.Effect<sns.RemovePermissionResponse, sns.RemovePermissionError>
  >
> {}

export const RemovePermission = Binding.Service<RemovePermission>(
  "AWS.SNS.RemovePermission",
);
