import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUpdateComplianceForGroupRequest extends Omit<
  adu.DeviceManagementGetUpdateComplianceForGroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get update compliance for group: `GET /deviceUpdate/{instance}/management/groups/{groupId}/updateCompliance` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateManagementReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/management/read`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetUpdateComplianceForGroupHttp}.
 *
 * ### Calling GetUpdateComplianceForGroup
 * **Example:** GetUpdateComplianceForGroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getUpdateComplianceForGroup = yield* Azure.DeviceUpdate.GetUpdateComplianceForGroup(instance);
 *
 * // runtime
 * const result = yield* getUpdateComplianceForGroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetUpdateComplianceForGroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetUpdateComplianceForGroup extends Binding.Service<
  GetUpdateComplianceForGroup,
  "Azure.DeviceUpdate.GetUpdateComplianceForGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUpdateComplianceForGroupRequest,
    ) => Effect.Effect<
      adu.UpdateCompliance,
      adu.DeviceManagementGetUpdateComplianceForGroupError,
      RuntimeContext
    >
  >
> {}

export const GetUpdateComplianceForGroup = Binding.Service<GetUpdateComplianceForGroup>(
  "Azure.DeviceUpdate.GetUpdateComplianceForGroup",
);
