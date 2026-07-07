import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface AddPermissionRequest extends Omit<
  sns.AddPermissionInput,
  "TopicArn"
> {}

/** @binding */
export interface AddPermission extends Binding.Service<
  AddPermission,
  "AWS.SNS.AddPermission",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: AddPermissionRequest,
    ) => Effect.Effect<sns.AddPermissionResponse, sns.AddPermissionError>
  >
> {}

export const AddPermission = Binding.Service<AddPermission>(
  "AWS.SNS.AddPermission",
);
