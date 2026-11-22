import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface RetryDeploymentRequest extends Omit<
  adu.RetryDeviceManagementDeploymentRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Retry deployment: `POST /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments/{deploymentId}:retry` on the Device Update data plane.
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
 * Provide {@link RetryDeploymentHttp}.
 *
 * ### Calling RetryDeployment
 * **Example:** RetryDeployment from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const retryDeployment = yield* Azure.DeviceUpdate.RetryDeployment(instance);
 *
 * // runtime
 * const result = yield* retryDeployment(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.RetryDeploymentHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface RetryDeployment extends Binding.Service<
  RetryDeployment,
  "Azure.DeviceUpdate.RetryDeployment",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: RetryDeploymentRequest,
    ) => Effect.Effect<adu.Deployment, adu.RetryDeviceManagementDeploymentError, RuntimeContext>
  >
> {}

export const RetryDeployment = Binding.Service<RetryDeployment>(
  "Azure.DeviceUpdate.RetryDeployment",
);
