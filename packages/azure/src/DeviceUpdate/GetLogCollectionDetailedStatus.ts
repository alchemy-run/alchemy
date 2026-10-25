import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetLogCollectionDetailedStatusRequest extends Omit<
  adu.GetDeviceManagementLogCollectionDetailedStatusRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get log collection detailed status: `GET /deviceUpdate/{instance}/management/deviceDiagnostics/logCollections/{operationId}/detailedStatus` on the Device Update data plane.
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
 * Provide {@link GetLogCollectionDetailedStatusHttp}.
 *
 * ### Calling GetLogCollectionDetailedStatus
 * **Example:** GetLogCollectionDetailedStatus from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getLogCollectionDetailedStatus = yield* Azure.DeviceUpdate.GetLogCollectionDetailedStatus(instance);
 *
 * // runtime
 * const result = yield* getLogCollectionDetailedStatus(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetLogCollectionDetailedStatusHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetLogCollectionDetailedStatus extends Binding.Service<
  GetLogCollectionDetailedStatus,
  "Azure.DeviceUpdate.GetLogCollectionDetailedStatus",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetLogCollectionDetailedStatusRequest,
    ) => Effect.Effect<
      adu.LogCollectionOperationDetailedStatus,
      adu.GetDeviceManagementLogCollectionDetailedStatusError,
      RuntimeContext
    >
  >
> {}

export const GetLogCollectionDetailedStatus = Binding.Service<GetLogCollectionDetailedStatus>(
  "Azure.DeviceUpdate.GetLogCollectionDetailedStatus",
);
