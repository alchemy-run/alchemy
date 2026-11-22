import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteDeploymentRequest extends Omit<
  adu.DeleteDeviceManagementDeploymentRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Delete deployment: `DELETE /deviceUpdate/{instance}/management/groups/{groupId}/deployments/{deploymentId}` on the Device Update data plane.
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
 * Provide {@link DeleteDeploymentHttp}.
 *
 * ### Calling DeleteDeployment
 * **Example:** DeleteDeployment from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const deleteDeployment = yield* Azure.DeviceUpdate.DeleteDeployment(instance);
 *
 * // runtime
 * const result = yield* deleteDeployment(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.DeleteDeploymentHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface DeleteDeployment extends Binding.Service<
  DeleteDeployment,
  "Azure.DeviceUpdate.DeleteDeployment",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteDeploymentRequest,
    ) => Effect.Effect<
      adu.DeleteDeviceManagementDeploymentResponse,
      adu.DeleteDeviceManagementDeploymentError,
      RuntimeContext
    >
  >
> {}

export const DeleteDeployment = Binding.Service<DeleteDeployment>(
  "Azure.DeviceUpdate.DeleteDeployment",
);
