import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeviceModuleRequest extends Omit<
  adu.GetDeviceManagementDeviceModuleRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get device module: `GET /deviceUpdate/{instance}/management/devices/{deviceId}/modules/{moduleId}` on the Device Update data plane.
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
 * Provide {@link GetDeviceModuleHttp}.
 *
 * ### Calling GetDeviceModule
 * **Example:** GetDeviceModule from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeviceModule = yield* Azure.DeviceUpdate.GetDeviceModule(instance);
 *
 * // runtime
 * const result = yield* getDeviceModule(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeviceModuleHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeviceModule extends Binding.Service<
  GetDeviceModule,
  "Azure.DeviceUpdate.GetDeviceModule",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeviceModuleRequest,
    ) => Effect.Effect<adu.Device, adu.GetDeviceManagementDeviceModuleError, RuntimeContext>
  >
> {}

export const GetDeviceModule = Binding.Service<GetDeviceModule>(
  "Azure.DeviceUpdate.GetDeviceModule",
);
