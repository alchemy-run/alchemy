import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUpdateRequest extends Omit<
  adu.DeviceUpdateGetUpdateRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get update: `GET /deviceUpdate/{instance}/updates/providers/{provider}/names/{name}/versions/{version}` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateUpdatesReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/updates/read`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetUpdateHttp}.
 *
 * ### Calling GetUpdate
 * **Example:** GetUpdate from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getUpdate = yield* Azure.DeviceUpdate.GetUpdate(instance);
 *
 * // runtime
 * const result = yield* getUpdate(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetUpdateHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetUpdate extends Binding.Service<
  GetUpdate,
  "Azure.DeviceUpdate.GetUpdate",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUpdateRequest,
    ) => Effect.Effect<adu.Update, adu.DeviceUpdateGetUpdateError, RuntimeContext>
  >
> {}

export const GetUpdate = Binding.Service<GetUpdate>("Azure.DeviceUpdate.GetUpdate");
