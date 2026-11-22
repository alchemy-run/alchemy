import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface StartLogCollectionRequest extends Omit<
  adu.StartDeviceManagementLogCollectionRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Start log collection: `PUT /deviceUpdate/{instance}/management/deviceDiagnostics/logCollections/{operationId}` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateManagementWriteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/management/write`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartLogCollectionHttp}.
 *
 * ### Calling StartLogCollection
 * **Example:** StartLogCollection from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const startLogCollection = yield* Azure.DeviceUpdate.StartLogCollection(instance);
 *
 * // runtime
 * const result = yield* startLogCollection(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.StartLogCollectionHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface StartLogCollection extends Binding.Service<
  StartLogCollection,
  "Azure.DeviceUpdate.StartLogCollection",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: StartLogCollectionRequest,
    ) => Effect.Effect<
      adu.LogCollection,
      adu.StartDeviceManagementLogCollectionError,
      RuntimeContext
    >
  >
> {}

export const StartLogCollection = Binding.Service<StartLogCollection>(
  "Azure.DeviceUpdate.StartLogCollection",
);
