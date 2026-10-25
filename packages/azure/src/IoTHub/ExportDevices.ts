import type * as iothub from "@distilled.cloud/azure/iothub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IotHub } from "./IotHub.ts";

export interface ExportDevicesRequest extends Omit<
  iothub.ExportIotHubResourceDevicesRequest,
  "subscriptionId" | "resourceGroupName" | "resourceName"
> {}

/**
 * Start a job that exports the hub's device identities to a blob container (`POST …/IotHubs/{resourceName}/exportDevices`) from any host. The hub writes the blob: pass a container SAS URI, or `authenticationType: "identityBased"` with a hub identity that can write the container.
 *
 * Binding assigns a custom role (`AzureIoTHubExportDevicesRole`, one per stack, with
 * exactly the action `Microsoft.Devices/iotHubs/exportDevices/Action`) on the IoT hub only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ExportDevicesHttp}.
 *
 * ### Calling ExportDevices
 * **Example:** ExportDevices from a Function
 * ```typescript
 * // init
 * const exportDevices = yield* Azure.IoTHub.ExportDevices(hub);
 *
 * // runtime
 * yield* exportDevices({ exportBlobContainerUri: sasUri, excludeKeys: true });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const exportDevices = yield* Azure.IoTHub.ExportDevices(hub);
 *   // ...
 * }).pipe(Effect.provide(Azure.IoTHub.ExportDevicesHttp));
 * ```
 *
 * @binding
 * @category IoTHub
 */
export interface ExportDevices extends Binding.Service<
  ExportDevices,
  "Azure.IoTHub.ExportDevices",
  (
    hub: IotHub,
  ) => Effect.Effect<
    (
      request: ExportDevicesRequest,
    ) => Effect.Effect<iothub.JobResponse, iothub.ExportIotHubResourceDevicesError, RuntimeContext>
  >
> {}

export const ExportDevices = Binding.Service<ExportDevices>("Azure.IoTHub.ExportDevices");
