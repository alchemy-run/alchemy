import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDevicesRequest extends Omit<
  adu.ListDeviceManagementDevicesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List devices: `GET /deviceUpdate/{instance}/management/devices` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListDevicesHttp}.
 *
 * ### Calling ListDevices
 * **Example:** ListDevices from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listDevices = yield* Azure.DeviceUpdate.ListDevices(instance);
 *
 * // runtime
 * const result = yield* listDevices();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListDevicesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListDevices extends Binding.Service<
  ListDevices,
  "Azure.DeviceUpdate.ListDevices",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListDevicesRequest,
    ) => Effect.Effect<adu.DevicesList, adu.ListDeviceManagementDevicesError, RuntimeContext>
  >
> {}

export const ListDevices = Binding.Service<ListDevices>("Azure.DeviceUpdate.ListDevices");
