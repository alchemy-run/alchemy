import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListGroupsRequest extends Omit<
  adu.ListDeviceManagementGroupsRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List groups: `GET /deviceUpdate/{instance}/management/groups` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListGroupsHttp}.
 *
 * ### Calling ListGroups
 * **Example:** ListGroups from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listGroups = yield* Azure.DeviceUpdate.ListGroups(instance);
 *
 * // runtime
 * const result = yield* listGroups();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListGroupsHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListGroups extends Binding.Service<
  ListGroups,
  "Azure.DeviceUpdate.ListGroups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListGroupsRequest,
    ) => Effect.Effect<adu.GroupsList, adu.ListDeviceManagementGroupsError, RuntimeContext>
  >
> {}

export const ListGroups = Binding.Service<ListGroups>("Azure.DeviceUpdate.ListGroups");
