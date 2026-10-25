import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeviceClassSubgroupDeploymentStatusRequest extends Omit<
  adu.GetDeviceManagementDeviceClassSubgroupDeploymentStatusRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get device class subgroup deployment status: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments/{deploymentId}/status` on the Device Update data plane.
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
 * Provide {@link GetDeviceClassSubgroupDeploymentStatusHttp}.
 *
 * ### Calling GetDeviceClassSubgroupDeploymentStatus
 * **Example:** GetDeviceClassSubgroupDeploymentStatus from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeviceClassSubgroupDeploymentStatus = yield* Azure.DeviceUpdate.GetDeviceClassSubgroupDeploymentStatus(instance);
 *
 * // runtime
 * const result = yield* getDeviceClassSubgroupDeploymentStatus(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeviceClassSubgroupDeploymentStatusHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeviceClassSubgroupDeploymentStatus extends Binding.Service<
  GetDeviceClassSubgroupDeploymentStatus,
  "Azure.DeviceUpdate.GetDeviceClassSubgroupDeploymentStatus",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeviceClassSubgroupDeploymentStatusRequest,
    ) => Effect.Effect<
      adu.DeviceClassSubgroupDeploymentStatus,
      adu.GetDeviceManagementDeviceClassSubgroupDeploymentStatusError,
      RuntimeContext
    >
  >
> {}

export const GetDeviceClassSubgroupDeploymentStatus =
  Binding.Service<GetDeviceClassSubgroupDeploymentStatus>(
    "Azure.DeviceUpdate.GetDeviceClassSubgroupDeploymentStatus",
  );
