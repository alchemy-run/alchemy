import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUpdateOperationStatusesRequest extends Omit<
  adu.ListDeviceUpdateOperationStatusesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List update operation statuses: `GET /deviceUpdate/{instance}/updates/operations` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListUpdateOperationStatusesHttp}.
 *
 * ### Calling ListUpdateOperationStatuses
 * **Example:** ListUpdateOperationStatuses from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listUpdateOperationStatuses = yield* Azure.DeviceUpdate.ListUpdateOperationStatuses(instance);
 *
 * // runtime
 * const result = yield* listUpdateOperationStatuses();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListUpdateOperationStatusesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListUpdateOperationStatuses extends Binding.Service<
  ListUpdateOperationStatuses,
  "Azure.DeviceUpdate.ListUpdateOperationStatuses",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListUpdateOperationStatusesRequest,
    ) => Effect.Effect<
      adu.UpdateOperationsList,
      adu.ListDeviceUpdateOperationStatusesError,
      RuntimeContext
    >
  >
> {}

export const ListUpdateOperationStatuses = Binding.Service<ListUpdateOperationStatuses>(
  "Azure.DeviceUpdate.ListUpdateOperationStatuses",
);
