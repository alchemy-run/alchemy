import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetLogCollectionRequest extends Omit<
  adu.GetDeviceManagementLogCollectionRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get log collection: `GET /deviceUpdate/{instance}/management/deviceDiagnostics/logCollections/{operationId}` on the Device Update data plane.
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
 * Provide {@link GetLogCollectionHttp}.
 *
 * ### Calling GetLogCollection
 * **Example:** GetLogCollection from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getLogCollection = yield* Azure.DeviceUpdate.GetLogCollection(instance);
 *
 * // runtime
 * const result = yield* getLogCollection(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetLogCollectionHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetLogCollection extends Binding.Service<
  GetLogCollection,
  "Azure.DeviceUpdate.GetLogCollection",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetLogCollectionRequest,
    ) => Effect.Effect<adu.LogCollection, adu.GetDeviceManagementLogCollectionError, RuntimeContext>
  >
> {}

export const GetLogCollection = Binding.Service<GetLogCollection>(
  "Azure.DeviceUpdate.GetLogCollection",
);
