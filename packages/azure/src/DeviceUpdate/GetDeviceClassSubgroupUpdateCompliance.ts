import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeviceClassSubgroupUpdateComplianceRequest extends Omit<
  adu.DeviceManagementGetDeviceClassSubgroupUpdateComplianceRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get device class subgroup update compliance: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/updateCompliance` on the Device Update data plane.
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
 * Provide {@link GetDeviceClassSubgroupUpdateComplianceHttp}.
 *
 * ### Calling GetDeviceClassSubgroupUpdateCompliance
 * **Example:** GetDeviceClassSubgroupUpdateCompliance from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeviceClassSubgroupUpdateCompliance = yield* Azure.DeviceUpdate.GetDeviceClassSubgroupUpdateCompliance(instance);
 *
 * // runtime
 * const result = yield* getDeviceClassSubgroupUpdateCompliance(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeviceClassSubgroupUpdateComplianceHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeviceClassSubgroupUpdateCompliance extends Binding.Service<
  GetDeviceClassSubgroupUpdateCompliance,
  "Azure.DeviceUpdate.GetDeviceClassSubgroupUpdateCompliance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeviceClassSubgroupUpdateComplianceRequest,
    ) => Effect.Effect<
      adu.UpdateCompliance,
      adu.DeviceManagementGetDeviceClassSubgroupUpdateComplianceError,
      RuntimeContext
    >
  >
> {}

export const GetDeviceClassSubgroupUpdateCompliance =
  Binding.Service<GetDeviceClassSubgroupUpdateCompliance>(
    "Azure.DeviceUpdate.GetDeviceClassSubgroupUpdateCompliance",
  );
