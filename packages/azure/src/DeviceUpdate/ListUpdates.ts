import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUpdatesRequest extends Omit<
  adu.ListDeviceUpdateUpdatesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List updates: `GET /deviceUpdate/{instance}/updates` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListUpdatesHttp}.
 *
 * ### Calling ListUpdates
 * **Example:** ListUpdates from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listUpdates = yield* Azure.DeviceUpdate.ListUpdates(instance);
 *
 * // runtime
 * const result = yield* listUpdates();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListUpdatesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListUpdates extends Binding.Service<
  ListUpdates,
  "Azure.DeviceUpdate.ListUpdates",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListUpdatesRequest,
    ) => Effect.Effect<adu.UpdateList, adu.ListDeviceUpdateUpdatesError, RuntimeContext>
  >
> {}

export const ListUpdates = Binding.Service<ListUpdates>("Azure.DeviceUpdate.ListUpdates");
