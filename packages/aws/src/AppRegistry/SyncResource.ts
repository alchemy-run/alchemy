import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppRegistryAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `servicecatalog:SyncResource`.
 *
 * Re-syncs a resource's AppRegistry system tags (`awsApplication`) with its
 * associated application — useful in remediation functions that repair
 * drifted application tags. The caller additionally needs permission to read
 * and update the target resource itself (e.g. `cloudformation:UpdateStack` +
 * `tag:GetResources` for a CloudFormation stack); grant those on the host
 * separately. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.SyncResourceHttp)`.
 * ### Syncing Resources
 * **Example:** Re-sync a CloudFormation Stack's Application Tag
 * ```typescript
 * // init — account-level, no resource argument
 * const syncResource = yield* AWS.AppRegistry.SyncResource();
 *
 * // runtime
 * const result = yield* syncResource({
 *   resourceType: "CFN_STACK",
 *   resource: "my-stack",
 * });
 * console.log(result.actionTaken);
 * ```
 *
 * @binding
 */
export interface SyncResource extends Binding.Service<
  SyncResource,
  "AWS.AppRegistry.SyncResource",
  () => Effect.Effect<
    (
      request: appregistry.SyncResourceRequest,
    ) => Effect.Effect<appregistry.SyncResourceResponse, appregistry.SyncResourceError>
  >
> {}

export const SyncResource = Binding.Service<SyncResource>("AWS.AppRegistry.SyncResource");

export const SyncResourceHttp = Layer.effect(
  SyncResource,
  makeAppRegistryAccountHttpBinding({
    tag: "AWS.AppRegistry.SyncResource",
    operation: appregistry.syncResource,
    // The target is an arbitrary external resource, so nothing here supports
    // resource-level scoping. SyncResource verifies the CALLER can read and
    // update the target resource, so the documented companion permissions
    // (CloudFormation + resource-tagging) are granted alongside.
    actions: [
      "servicecatalog:SyncResource",
      "cloudformation:DescribeStacks",
      "cloudformation:UpdateStack",
      "tag:GetResources",
      "tag:TagResources",
      "tag:UntagResources",
    ],
  }),
);
