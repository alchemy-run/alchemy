import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetBestUpdatesForDeviceClassSubgroupRequest extends Omit<
  adu.GetDeviceManagementBestUpdatesForDeviceClassSubgroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get best updates for device class subgroup: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/bestUpdates` on the Device Update data plane.
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
 * Provide {@link GetBestUpdatesForDeviceClassSubgroupHttp}.
 *
 * ### Calling GetBestUpdatesForDeviceClassSubgroup
 * **Example:** GetBestUpdatesForDeviceClassSubgroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getBestUpdatesForDeviceClassSubgroup = yield* Azure.DeviceUpdate.GetBestUpdatesForDeviceClassSubgroup(instance);
 *
 * // runtime
 * const result = yield* getBestUpdatesForDeviceClassSubgroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetBestUpdatesForDeviceClassSubgroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetBestUpdatesForDeviceClassSubgroup extends Binding.Service<
  GetBestUpdatesForDeviceClassSubgroup,
  "Azure.DeviceUpdate.GetBestUpdatesForDeviceClassSubgroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetBestUpdatesForDeviceClassSubgroupRequest,
    ) => Effect.Effect<
      adu.DeviceClassSubgroupUpdatableDevices,
      adu.GetDeviceManagementBestUpdatesForDeviceClassSubgroupError,
      RuntimeContext
    >
  >
> {}

export const GetBestUpdatesForDeviceClassSubgroup =
  Binding.Service<GetBestUpdatesForDeviceClassSubgroup>(
    "Azure.DeviceUpdate.GetBestUpdatesForDeviceClassSubgroup",
  );
