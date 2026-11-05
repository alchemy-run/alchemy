import * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `GetSupportedResourceTypes` operation (IAM action
 * `backup:GetSupportedResourceTypes`).
 *
 * Returns the AWS resource types AWS Backup supports (e.g. `DynamoDB`,
 * `EBS`, `RDS`). Provide the implementation with
 * `Effect.provide(AWS.Backup.GetSupportedResourceTypesHttp)`.
 * ### Protected Resources
 * **Example:** List Supported Resource Types
 * ```typescript
 * const getSupportedResourceTypes =
 *   yield* AWS.Backup.GetSupportedResourceTypes();
 *
 * const { ResourceTypes } = yield* getSupportedResourceTypes();
 * ```
 *
 * @binding
 */
export interface GetSupportedResourceTypes extends Binding.Service<
  GetSupportedResourceTypes,
  "AWS.Backup.GetSupportedResourceTypes",
  () => Effect.Effect<
    (
      request?: backup.GetSupportedResourceTypesRequest,
    ) => Effect.Effect<
      backup.GetSupportedResourceTypesOutput,
      backup.GetSupportedResourceTypesError
    >
  >
> {}
export const GetSupportedResourceTypes = Binding.Service<GetSupportedResourceTypes>(
  "AWS.Backup.GetSupportedResourceTypes",
);

export const GetSupportedResourceTypesHttp = Layer.effect(
  GetSupportedResourceTypes,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.GetSupportedResourceTypes",
    operation: backup.getSupportedResourceTypes,
    actions: ["backup:GetSupportedResourceTypes"],
  }),
);
