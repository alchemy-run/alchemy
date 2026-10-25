import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUpdateOperationStatusRequest extends Omit<
  adu.GetDeviceUpdateOperationStatusRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get update operation status: `GET /deviceUpdate/{instance}/updates/operations/{operationId}` on the Device Update data plane.
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
 * Provide {@link GetUpdateOperationStatusHttp}.
 *
 * ### Calling GetUpdateOperationStatus
 * **Example:** GetUpdateOperationStatus from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getUpdateOperationStatus = yield* Azure.DeviceUpdate.GetUpdateOperationStatus(instance);
 *
 * // runtime
 * const result = yield* getUpdateOperationStatus(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetUpdateOperationStatusHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetUpdateOperationStatus extends Binding.Service<
  GetUpdateOperationStatus,
  "Azure.DeviceUpdate.GetUpdateOperationStatus",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUpdateOperationStatusRequest,
    ) => Effect.Effect<
      adu.GetDeviceUpdateOperationStatusResponse,
      adu.GetDeviceUpdateOperationStatusError,
      RuntimeContext
    >
  >
> {}

export const GetUpdateOperationStatus = Binding.Service<GetUpdateOperationStatus>(
  "Azure.DeviceUpdate.GetUpdateOperationStatus",
);
