import * as iothub from "@distilled.cloud/azure/iothub";
import * as Layer from "effect/Layer";
import { IoTHubRole, makeIotHubActionBinding } from "./BindingHttp.ts";
import { ImportDevices } from "./ImportDevices.ts";

/**
 * Implementation of {@link ImportDevices} over the distilled `iothub` ARM
 * API. Assigns the custom `AzureIoTHubImportDevicesRole` on the IoT hub.
 *
 * @layer
 * @provides Azure.IoTHub.ImportDevices
 */
export const ImportDevicesHttp = Layer.effect(
  ImportDevices,
  makeIotHubActionBinding({
    tag: "Azure.IoTHub.ImportDevices",
    operation: iothub.ImportIotHubResourceDevices,
    role: IoTHubRole.ImportDevices,
  }),
);
