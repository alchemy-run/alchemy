import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeploymentStatusRequest extends Omit<
  adu.GetDeviceManagementDeploymentStatusRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get deployment status: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deployments/{deploymentId}/status` on the Device Update data plane.
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
 * Provide {@link GetDeploymentStatusHttp}.
 *
 * ### Calling GetDeploymentStatus
 * **Example:** GetDeploymentStatus from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeploymentStatus = yield* Azure.DeviceUpdate.GetDeploymentStatus(instance);
 *
 * // runtime
 * const result = yield* getDeploymentStatus(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeploymentStatusHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeploymentStatus extends Binding.Service<
  GetDeploymentStatus,
  "Azure.DeviceUpdate.GetDeploymentStatus",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeploymentStatusRequest,
    ) => Effect.Effect<
      adu.DeploymentStatus,
      adu.GetDeviceManagementDeploymentStatusError,
      RuntimeContext
    >
  >
> {}

export const GetDeploymentStatus = Binding.Service<GetDeploymentStatus>(
  "Azure.DeviceUpdate.GetDeploymentStatus",
);
