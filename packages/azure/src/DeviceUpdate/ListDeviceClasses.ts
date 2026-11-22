import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDeviceClassesRequest extends Omit<
  adu.ListDeviceManagementDeviceClassesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List device classes: `GET /deviceUpdate/{instance}/management/deviceClasses` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListDeviceClassesHttp}.
 *
 * ### Calling ListDeviceClasses
 * **Example:** ListDeviceClasses from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listDeviceClasses = yield* Azure.DeviceUpdate.ListDeviceClasses(instance);
 *
 * // runtime
 * const result = yield* listDeviceClasses();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListDeviceClassesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListDeviceClasses extends Binding.Service<
  ListDeviceClasses,
  "Azure.DeviceUpdate.ListDeviceClasses",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListDeviceClassesRequest,
    ) => Effect.Effect<
      adu.DeviceClassesList,
      adu.ListDeviceManagementDeviceClassesError,
      RuntimeContext
    >
  >
> {}

export const ListDeviceClasses = Binding.Service<ListDeviceClasses>(
  "Azure.DeviceUpdate.ListDeviceClasses",
);
