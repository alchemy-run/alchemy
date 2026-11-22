import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeviceClassRequest extends Omit<
  adu.GetDeviceManagementDeviceClassRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get device class: `GET /deviceUpdate/{instance}/management/deviceClasses/{deviceClassId}` on the Device Update data plane.
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
 * Provide {@link GetDeviceClassHttp}.
 *
 * ### Calling GetDeviceClass
 * **Example:** GetDeviceClass from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDeviceClass = yield* Azure.DeviceUpdate.GetDeviceClass(instance);
 *
 * // runtime
 * const result = yield* getDeviceClass(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeviceClassHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDeviceClass extends Binding.Service<
  GetDeviceClass,
  "Azure.DeviceUpdate.GetDeviceClass",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeviceClassRequest,
    ) => Effect.Effect<adu.DeviceClass, adu.GetDeviceManagementDeviceClassError, RuntimeContext>
  >
> {}

export const GetDeviceClass = Binding.Service<GetDeviceClass>("Azure.DeviceUpdate.GetDeviceClass");
