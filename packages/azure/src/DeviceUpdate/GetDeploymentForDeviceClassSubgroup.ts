import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeploymentForDeviceClassSubgroupRequest extends Omit<
  adu.GetDeviceManagementDeploymentForDeviceClassSubgroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get deployment for device class subgroup: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments/{deploymentId}` on the Device Update data plane.
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
 * Provide {@link GetDeploymentForDeviceClassSubgroupHttp}.
 *
 * ### Calling GetDeploymentForDeviceClassSubgroup
 * **Example:** GetDeploymentForDeviceClassSubgroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeploymentForDeviceClassSubgroup = yield* Azure.DeviceUpdate.GetDeploymentForDeviceClassSubgroup(instance);
 *
 * // runtime
 * const result = yield* getDeploymentForDeviceClassSubgroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeploymentForDeviceClassSubgroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeploymentForDeviceClassSubgroup extends Binding.Service<
  GetDeploymentForDeviceClassSubgroup,
  "Azure.DeviceUpdate.GetDeploymentForDeviceClassSubgroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeploymentForDeviceClassSubgroupRequest,
    ) => Effect.Effect<
      adu.Deployment,
      adu.GetDeviceManagementDeploymentForDeviceClassSubgroupError,
      RuntimeContext
    >
  >
> {}

export const GetDeploymentForDeviceClassSubgroup =
  Binding.Service<GetDeploymentForDeviceClassSubgroup>(
    "Azure.DeviceUpdate.GetDeploymentForDeviceClassSubgroup",
  );
