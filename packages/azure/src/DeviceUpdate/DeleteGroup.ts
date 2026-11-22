import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteGroupRequest extends Omit<
  adu.DeleteDeviceManagementGroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Delete group: `DELETE /deviceUpdate/{instance}/management/groups/{groupId}` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateManagementDeleteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/management/delete`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteGroupHttp}.
 *
 * ### Calling DeleteGroup
 * **Example:** DeleteGroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const deleteGroup = yield* Azure.DeviceUpdate.DeleteGroup(instance);
 *
 * // runtime
 * const result = yield* deleteGroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.DeleteGroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface DeleteGroup extends Binding.Service<
  DeleteGroup,
  "Azure.DeviceUpdate.DeleteGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteGroupRequest,
    ) => Effect.Effect<
      adu.DeleteDeviceManagementGroupResponse,
      adu.DeleteDeviceManagementGroupError,
      RuntimeContext
    >
  >
> {}

export const DeleteGroup = Binding.Service<DeleteGroup>("Azure.DeviceUpdate.DeleteGroup");
