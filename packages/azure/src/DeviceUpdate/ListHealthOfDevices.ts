import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListHealthOfDevicesRequest extends Omit<
  adu.ListDeviceManagementHealthOfDevicesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List health of devices: `GET /deviceUpdate/{instance}/management/deviceDiagnostics/deviceHealth` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListHealthOfDevicesHttp}.
 *
 * ### Calling ListHealthOfDevices
 * **Example:** ListHealthOfDevices from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listHealthOfDevices = yield* Azure.DeviceUpdate.ListHealthOfDevices(instance);
 *
 * // runtime
 * const result = yield* listHealthOfDevices(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListHealthOfDevicesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListHealthOfDevices extends Binding.Service<
  ListHealthOfDevices,
  "Azure.DeviceUpdate.ListHealthOfDevices",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListHealthOfDevicesRequest,
    ) => Effect.Effect<
      adu.DeviceHealthList,
      adu.ListDeviceManagementHealthOfDevicesError,
      RuntimeContext
    >
  >
> {}

export const ListHealthOfDevices = Binding.Service<ListHealthOfDevices>(
  "Azure.DeviceUpdate.ListHealthOfDevices",
);
