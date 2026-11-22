import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateOrUpdateDeploymentRequest extends Omit<
  adu.DeviceManagementCreateOrUpdateDeploymentRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Create or update deployment: `PUT /deviceUpdate/{instance}/management/groups/{groupId}/deployments/{deploymentId}` on the Device Update data plane.
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
 * Provide {@link CreateOrUpdateDeploymentHttp}.
 *
 * ### Calling CreateOrUpdateDeployment
 * **Example:** CreateOrUpdateDeployment from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const createOrUpdateDeployment = yield* Azure.DeviceUpdate.CreateOrUpdateDeployment(instance);
 *
 * // runtime
 * const result = yield* createOrUpdateDeployment(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.CreateOrUpdateDeploymentHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface CreateOrUpdateDeployment extends Binding.Service<
  CreateOrUpdateDeployment,
  "Azure.DeviceUpdate.CreateOrUpdateDeployment",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateDeploymentRequest,
    ) => Effect.Effect<
      adu.Deployment,
      adu.DeviceManagementCreateOrUpdateDeploymentError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateDeployment = Binding.Service<CreateOrUpdateDeployment>(
  "Azure.DeviceUpdate.CreateOrUpdateDeployment",
);
