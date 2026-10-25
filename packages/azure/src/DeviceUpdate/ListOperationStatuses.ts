import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListOperationStatusesRequest extends Omit<
  adu.ListDeviceManagementOperationStatusesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List operation statuses: `GET /deviceUpdate/{instance}/management/operations` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListOperationStatusesHttp}.
 *
 * ### Calling ListOperationStatuses
 * **Example:** ListOperationStatuses from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listOperationStatuses = yield* Azure.DeviceUpdate.ListOperationStatuses(instance);
 *
 * // runtime
 * const result = yield* listOperationStatuses();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListOperationStatusesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListOperationStatuses extends Binding.Service<
  ListOperationStatuses,
  "Azure.DeviceUpdate.ListOperationStatuses",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListOperationStatusesRequest,
    ) => Effect.Effect<
      adu.DeviceOperationsList,
      adu.ListDeviceManagementOperationStatusesError,
      RuntimeContext
    >
  >
> {}

export const ListOperationStatuses = Binding.Service<ListOperationStatuses>(
  "Azure.DeviceUpdate.ListOperationStatuses",
);
