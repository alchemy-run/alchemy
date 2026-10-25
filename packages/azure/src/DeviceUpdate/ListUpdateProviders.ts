import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUpdateProvidersRequest extends Omit<
  adu.ListDeviceUpdateProvidersRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List update providers: `GET /deviceUpdate/{instance}/updates/providers` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListUpdateProvidersHttp}.
 *
 * ### Calling ListUpdateProviders
 * **Example:** ListUpdateProviders from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listUpdateProviders = yield* Azure.DeviceUpdate.ListUpdateProviders(instance);
 *
 * // runtime
 * const result = yield* listUpdateProviders();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListUpdateProvidersHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListUpdateProviders extends Binding.Service<
  ListUpdateProviders,
  "Azure.DeviceUpdate.ListUpdateProviders",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListUpdateProvidersRequest,
    ) => Effect.Effect<adu.StringsList, adu.ListDeviceUpdateProvidersError, RuntimeContext>
  >
> {}

export const ListUpdateProviders = Binding.Service<ListUpdateProviders>(
  "Azure.DeviceUpdate.ListUpdateProviders",
);
