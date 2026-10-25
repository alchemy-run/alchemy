import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface StopDeploymentRequest extends Omit<
  adu.StopDeviceManagementDeploymentRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Stop deployment: `POST /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments/{deploymentId}:cancel` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateManagementWriteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/management/write`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopDeploymentHttp}.
 *
 * ### Calling StopDeployment
 * **Example:** StopDeployment from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const stopDeployment = yield* Azure.DeviceUpdate.StopDeployment(instance);
 *
 * // runtime
 * const result = yield* stopDeployment(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.StopDeploymentHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface StopDeployment extends Binding.Service<
  StopDeployment,
  "Azure.DeviceUpdate.StopDeployment",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: StopDeploymentRequest,
    ) => Effect.Effect<adu.Deployment, adu.StopDeviceManagementDeploymentError, RuntimeContext>
  >
> {}

export const StopDeployment = Binding.Service<StopDeployment>("Azure.DeviceUpdate.StopDeployment");
