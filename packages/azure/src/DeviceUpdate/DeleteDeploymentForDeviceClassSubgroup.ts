import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteDeploymentForDeviceClassSubgroupRequest extends Omit<
  adu.DeleteDeviceManagementDeploymentForDeviceClassSubgroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Delete deployment for device class subgroup: `DELETE /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments/{deploymentId}` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateManagementDeleteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/management/delete`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDeploymentForDeviceClassSubgroupHttp}.
 *
 * ### Calling DeleteDeploymentForDeviceClassSubgroup
 * **Example:** DeleteDeploymentForDeviceClassSubgroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const deleteDeploymentForDeviceClassSubgroup = yield* Azure.DeviceUpdate.DeleteDeploymentForDeviceClassSubgroup(instance);
 *
 * // runtime
 * const result = yield* deleteDeploymentForDeviceClassSubgroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.DeleteDeploymentForDeviceClassSubgroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface DeleteDeploymentForDeviceClassSubgroup extends Binding.Service<
  DeleteDeploymentForDeviceClassSubgroup,
  "Azure.DeviceUpdate.DeleteDeploymentForDeviceClassSubgroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteDeploymentForDeviceClassSubgroupRequest,
    ) => Effect.Effect<
      adu.DeleteDeviceManagementDeploymentForDeviceClassSubgroupResponse,
      adu.DeleteDeviceManagementDeploymentForDeviceClassSubgroupError,
      RuntimeContext
    >
  >
> {}

export const DeleteDeploymentForDeviceClassSubgroup =
  Binding.Service<DeleteDeploymentForDeviceClassSubgroup>(
    "Azure.DeviceUpdate.DeleteDeploymentForDeviceClassSubgroup",
  );
