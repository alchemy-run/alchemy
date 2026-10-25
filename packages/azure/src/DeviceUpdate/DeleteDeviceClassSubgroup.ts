import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteDeviceClassSubgroupRequest extends Omit<
  adu.DeleteDeviceManagementDeviceClassSubgroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Delete device class subgroup: `DELETE /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}` on the Device Update data plane.
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
 * Provide {@link DeleteDeviceClassSubgroupHttp}.
 *
 * ### Calling DeleteDeviceClassSubgroup
 * **Example:** DeleteDeviceClassSubgroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const deleteDeviceClassSubgroup = yield* Azure.DeviceUpdate.DeleteDeviceClassSubgroup(instance);
 *
 * // runtime
 * const result = yield* deleteDeviceClassSubgroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.DeleteDeviceClassSubgroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface DeleteDeviceClassSubgroup extends Binding.Service<
  DeleteDeviceClassSubgroup,
  "Azure.DeviceUpdate.DeleteDeviceClassSubgroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteDeviceClassSubgroupRequest,
    ) => Effect.Effect<
      adu.DeleteDeviceManagementDeviceClassSubgroupResponse,
      adu.DeleteDeviceManagementDeviceClassSubgroupError,
      RuntimeContext
    >
  >
> {}

export const DeleteDeviceClassSubgroup = Binding.Service<DeleteDeviceClassSubgroup>(
  "Azure.DeviceUpdate.DeleteDeviceClassSubgroup",
);
