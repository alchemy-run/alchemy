import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeviceClassSubgroupRequest extends Omit<
  adu.GetDeviceManagementDeviceClassSubgroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get device class subgroup: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}` on the Device Update data plane.
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
 * Provide {@link GetDeviceClassSubgroupHttp}.
 *
 * ### Calling GetDeviceClassSubgroup
 * **Example:** GetDeviceClassSubgroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeviceClassSubgroup = yield* Azure.DeviceUpdate.GetDeviceClassSubgroup(instance);
 *
 * // runtime
 * const result = yield* getDeviceClassSubgroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeviceClassSubgroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeviceClassSubgroup extends Binding.Service<
  GetDeviceClassSubgroup,
  "Azure.DeviceUpdate.GetDeviceClassSubgroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeviceClassSubgroupRequest,
    ) => Effect.Effect<
      adu.DeviceClassSubgroup,
      adu.GetDeviceManagementDeviceClassSubgroupError,
      RuntimeContext
    >
  >
> {}

export const GetDeviceClassSubgroup = Binding.Service<GetDeviceClassSubgroup>(
  "Azure.DeviceUpdate.GetDeviceClassSubgroup",
);
