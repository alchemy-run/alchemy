import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListBestUpdatesForGroupRequest extends Omit<
  adu.ListDeviceManagementBestUpdatesForGroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List best updates for group: `GET /deviceUpdate/{instance}/management/groups/{groupId}/bestUpdates` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListBestUpdatesForGroupHttp}.
 *
 * ### Calling ListBestUpdatesForGroup
 * **Example:** ListBestUpdatesForGroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listBestUpdatesForGroup = yield* Azure.DeviceUpdate.ListBestUpdatesForGroup(instance);
 *
 * // runtime
 * const result = yield* listBestUpdatesForGroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListBestUpdatesForGroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListBestUpdatesForGroup extends Binding.Service<
  ListBestUpdatesForGroup,
  "Azure.DeviceUpdate.ListBestUpdatesForGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListBestUpdatesForGroupRequest,
    ) => Effect.Effect<
      adu.DeviceClassSubgroupUpdatableDevicesList,
      adu.ListDeviceManagementBestUpdatesForGroupError,
      RuntimeContext
    >
  >
> {}

export const ListBestUpdatesForGroup = Binding.Service<ListBestUpdatesForGroup>(
  "Azure.DeviceUpdate.ListBestUpdatesForGroup",
);
