import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeploymentRequest extends Omit<
  adu.GetDeviceManagementDeploymentRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get deployment: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deployments/{deploymentId}` on the Device Update data plane.
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
 * Provide {@link GetDeploymentHttp}.
 *
 * ### Calling GetDeployment
 * **Example:** GetDeployment from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeployment = yield* Azure.DeviceUpdate.GetDeployment(instance);
 *
 * // runtime
 * const result = yield* getDeployment(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeploymentHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "Azure.DeviceUpdate.GetDeployment",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeploymentRequest,
    ) => Effect.Effect<adu.Deployment, adu.GetDeviceManagementDeploymentError, RuntimeContext>
  >
> {}

export const GetDeployment = Binding.Service<GetDeployment>("Azure.DeviceUpdate.GetDeployment");
