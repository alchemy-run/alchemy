import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateDeviceClassRequest extends Omit<
  adu.UpdateDeviceManagementDeviceClassRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Update device class: `PATCH /deviceUpdate/{instance}/management/deviceClasses/{deviceClassId}` on the Device Update data plane.
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
 * Provide {@link UpdateDeviceClassHttp}.
 *
 * ### Calling UpdateDeviceClass
 * **Example:** UpdateDeviceClass from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const updateDeviceClass = yield* Azure.DeviceUpdate.UpdateDeviceClass(instance);
 *
 * // runtime
 * const result = yield* updateDeviceClass(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.UpdateDeviceClassHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface UpdateDeviceClass extends Binding.Service<
  UpdateDeviceClass,
  "Azure.DeviceUpdate.UpdateDeviceClass",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateDeviceClassRequest,
    ) => Effect.Effect<adu.DeviceClass, adu.UpdateDeviceManagementDeviceClassError, RuntimeContext>
  >
> {}

export const UpdateDeviceClass = Binding.Service<UpdateDeviceClass>(
  "Azure.DeviceUpdate.UpdateDeviceClass",
);
