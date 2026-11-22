import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListLogCollectionsRequest extends Omit<
  adu.ListDeviceManagementLogCollectionsRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List log collections: `GET /deviceUpdate/{instance}/management/deviceDiagnostics/logCollections` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListLogCollectionsHttp}.
 *
 * ### Calling ListLogCollections
 * **Example:** ListLogCollections from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listLogCollections = yield* Azure.DeviceUpdate.ListLogCollections(instance);
 *
 * // runtime
 * const result = yield* listLogCollections();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListLogCollectionsHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListLogCollections extends Binding.Service<
  ListLogCollections,
  "Azure.DeviceUpdate.ListLogCollections",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListLogCollectionsRequest,
    ) => Effect.Effect<
      adu.LogCollectionList,
      adu.ListDeviceManagementLogCollectionsError,
      RuntimeContext
    >
  >
> {}

export const ListLogCollections = Binding.Service<ListLogCollections>(
  "Azure.DeviceUpdate.ListLogCollections",
);
