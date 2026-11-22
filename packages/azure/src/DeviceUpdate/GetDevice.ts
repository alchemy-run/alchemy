import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeviceRequest extends Omit<
  adu.GetDeviceManagementDeviceRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get device: `GET /deviceUpdate/{instance}/management/devices/{deviceId}` on the Device Update data plane.
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
 * Provide {@link GetDeviceHttp}.
 *
 * ### Calling GetDevice
 * **Example:** GetDevice from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getDevice = yield* Azure.DeviceUpdate.GetDevice(instance);
 *
 * // runtime
 * const result = yield* getDevice(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetDeviceHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetDevice extends Binding.Service<
  GetDevice,
  "Azure.DeviceUpdate.GetDevice",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeviceRequest,
    ) => Effect.Effect<adu.Device, adu.GetDeviceManagementDeviceError, RuntimeContext>
  >
> {}

export const GetDevice = Binding.Service<GetDevice>("Azure.DeviceUpdate.GetDevice");
