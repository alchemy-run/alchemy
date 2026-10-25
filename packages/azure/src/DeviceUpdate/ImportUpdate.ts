import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ImportUpdateRequest extends Omit<
  adu.DeviceUpdateImportUpdateRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Import update: `POST /deviceUpdate/{instance}/updates:import` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateUpdatesWriteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/updates/write`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ImportUpdateHttp}.
 *
 * ### Calling ImportUpdate
 * **Example:** ImportUpdate from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const importUpdate = yield* Azure.DeviceUpdate.ImportUpdate(instance);
 *
 * // runtime
 * const result = yield* importUpdate(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ImportUpdateHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ImportUpdate extends Binding.Service<
  ImportUpdate,
  "Azure.DeviceUpdate.ImportUpdate",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ImportUpdateRequest,
    ) => Effect.Effect<
      adu.DeviceUpdateImportUpdateResponse,
      adu.DeviceUpdateImportUpdateError,
      RuntimeContext
    >
  >
> {}

export const ImportUpdate = Binding.Service<ImportUpdate>("Azure.DeviceUpdate.ImportUpdate");
