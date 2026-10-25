import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListInstallableUpdatesForDeviceClassRequest extends Omit<
  adu.ListDeviceManagementInstallableUpdatesForDeviceClassRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List installable updates for device class: `GET /deviceUpdate/{instance}/management/deviceClasses/{deviceClassId}/installableUpdates` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListInstallableUpdatesForDeviceClassHttp}.
 *
 * ### Calling ListInstallableUpdatesForDeviceClass
 * **Example:** ListInstallableUpdatesForDeviceClass from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listInstallableUpdatesForDeviceClass = yield* Azure.DeviceUpdate.ListInstallableUpdatesForDeviceClass(instance);
 *
 * // runtime
 * const result = yield* listInstallableUpdatesForDeviceClass(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListInstallableUpdatesForDeviceClassHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListInstallableUpdatesForDeviceClass extends Binding.Service<
  ListInstallableUpdatesForDeviceClass,
  "Azure.DeviceUpdate.ListInstallableUpdatesForDeviceClass",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListInstallableUpdatesForDeviceClassRequest,
    ) => Effect.Effect<
      adu.UpdateInfoList,
      adu.ListDeviceManagementInstallableUpdatesForDeviceClassError,
      RuntimeContext
    >
  >
> {}

export const ListInstallableUpdatesForDeviceClass =
  Binding.Service<ListInstallableUpdatesForDeviceClass>(
    "Azure.DeviceUpdate.ListInstallableUpdatesForDeviceClass",
  );
