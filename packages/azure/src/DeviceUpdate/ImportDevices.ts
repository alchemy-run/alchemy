import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ImportDevicesRequest extends Omit<
  adu.ImportDeviceManagementDevicesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Import devices: `POST /deviceUpdate/{instance}/management/devices:import` on the Device Update data plane.
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
 * Provide {@link ImportDevicesHttp}.
 *
 * ### Calling ImportDevices
 * **Example:** ImportDevices from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const importDevices = yield* Azure.DeviceUpdate.ImportDevices(instance);
 *
 * // runtime
 * const result = yield* importDevices(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ImportDevicesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ImportDevices extends Binding.Service<
  ImportDevices,
  "Azure.DeviceUpdate.ImportDevices",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ImportDevicesRequest,
    ) => Effect.Effect<
      adu.ImportDeviceManagementDevicesResponse,
      adu.ImportDeviceManagementDevicesError,
      RuntimeContext
    >
  >
> {}

export const ImportDevices = Binding.Service<ImportDevices>("Azure.DeviceUpdate.ImportDevices");
