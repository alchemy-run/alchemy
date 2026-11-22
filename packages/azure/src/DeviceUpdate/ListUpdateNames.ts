import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUpdateNamesRequest extends Omit<
  adu.ListDeviceUpdateNamesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List update names: `GET /deviceUpdate/{instance}/updates/providers/{provider}/names` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListUpdateNamesHttp}.
 *
 * ### Calling ListUpdateNames
 * **Example:** ListUpdateNames from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listUpdateNames = yield* Azure.DeviceUpdate.ListUpdateNames(instance);
 *
 * // runtime
 * const result = yield* listUpdateNames(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListUpdateNamesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListUpdateNames extends Binding.Service<
  ListUpdateNames,
  "Azure.DeviceUpdate.ListUpdateNames",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListUpdateNamesRequest,
    ) => Effect.Effect<adu.StringsList, adu.ListDeviceUpdateNamesError, RuntimeContext>
  >
> {}

export const ListUpdateNames = Binding.Service<ListUpdateNames>(
  "Azure.DeviceUpdate.ListUpdateNames",
);
