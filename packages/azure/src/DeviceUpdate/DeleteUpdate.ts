import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteUpdateRequest extends Omit<
  adu.DeviceUpdateDeleteUpdateRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Delete update: `DELETE /deviceUpdate/{instance}/updates/providers/{provider}/names/{name}/versions/{version}` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateUpdatesDeleteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/updates/delete`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteUpdateHttp}.
 *
 * ### Calling DeleteUpdate
 * **Example:** DeleteUpdate from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const deleteUpdate = yield* Azure.DeviceUpdate.DeleteUpdate(instance);
 *
 * // runtime
 * const result = yield* deleteUpdate(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.DeleteUpdateHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface DeleteUpdate extends Binding.Service<
  DeleteUpdate,
  "Azure.DeviceUpdate.DeleteUpdate",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteUpdateRequest,
    ) => Effect.Effect<
      adu.DeviceUpdateDeleteUpdateResponse,
      adu.DeviceUpdateDeleteUpdateError,
      RuntimeContext
    >
  >
> {}

export const DeleteUpdate = Binding.Service<DeleteUpdate>("Azure.DeviceUpdate.DeleteUpdate");
