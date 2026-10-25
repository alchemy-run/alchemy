import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDeviceClassSubgroupsForGroupRequest extends Omit<
  adu.ListDeviceManagementDeviceClassSubgroupsForGroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List device class subgroups for group: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListDeviceClassSubgroupsForGroupHttp}.
 *
 * ### Calling ListDeviceClassSubgroupsForGroup
 * **Example:** ListDeviceClassSubgroupsForGroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listDeviceClassSubgroupsForGroup = yield* Azure.DeviceUpdate.ListDeviceClassSubgroupsForGroup(instance);
 *
 * // runtime
 * const result = yield* listDeviceClassSubgroupsForGroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListDeviceClassSubgroupsForGroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListDeviceClassSubgroupsForGroup extends Binding.Service<
  ListDeviceClassSubgroupsForGroup,
  "Azure.DeviceUpdate.ListDeviceClassSubgroupsForGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListDeviceClassSubgroupsForGroupRequest,
    ) => Effect.Effect<
      adu.DeviceClassSubgroupsList,
      adu.ListDeviceManagementDeviceClassSubgroupsForGroupError,
      RuntimeContext
    >
  >
> {}

export const ListDeviceClassSubgroupsForGroup = Binding.Service<ListDeviceClassSubgroupsForGroup>(
  "Azure.DeviceUpdate.ListDeviceClassSubgroupsForGroup",
);
