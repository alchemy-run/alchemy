import type * as iothub from "@distilled.cloud/azure/iothub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IotHub } from "./IotHub.ts";

export interface ImportDevicesRequest extends Omit<
  iothub.ImportIotHubResourceDevicesRequest,
  "subscriptionId" | "resourceGroupName" | "resourceName"
> {}

/**
 * Start a job that imports, updates or deletes device identities from a blob (`POST …/IotHubs/{resourceName}/importDevices`) from any host. The hub reads the input container and writes the job log to the output container: pass container SAS URIs, or `authenticationType: "identityBased"` with a hub identity that can use them.
 *
 * Binding assigns a custom role (`AzureIoTHubImportDevicesRole`, one per stack, with
 * exactly the action `Microsoft.Devices/iotHubs/importDevices/Action`) on the IoT hub only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ImportDevicesHttp}.
 *
 * ### Calling ImportDevices
 * **Example:** ImportDevices from a Function
 * ```typescript
 * // init
 * const importDevices = yield* Azure.IoTHub.ImportDevices(hub);
 *
 * // runtime
 * yield* importDevices({ inputBlobContainerUri: inputSas, outputBlobContainerUri: outputSas });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const importDevices = yield* Azure.IoTHub.ImportDevices(hub);
 *   // ...
 * }).pipe(Effect.provide(Azure.IoTHub.ImportDevicesHttp));
 * ```
 *
 * @binding
 * @category IoTHub
 */
export interface ImportDevices extends Binding.Service<
  ImportDevices,
  "Azure.IoTHub.ImportDevices",
  (
    hub: IotHub,
  ) => Effect.Effect<
    (
      request: ImportDevicesRequest,
    ) => Effect.Effect<iothub.JobResponse, iothub.ImportIotHubResourceDevicesError, RuntimeContext>
  >
> {}

export const ImportDevices = Binding.Service<ImportDevices>("Azure.IoTHub.ImportDevices");
