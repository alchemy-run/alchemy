import * as iothub from "@distilled.cloud/azure/iothub";
import * as Layer from "effect/Layer";
import { IoTHubRole, makeIotHubActionBinding } from "./BindingHttp.ts";
import { ExportDevices } from "./ExportDevices.ts";

/**
 * Implementation of {@link ExportDevices} over the distilled `iothub` ARM
 * API. Assigns the custom `AzureIoTHubExportDevicesRole` on the IoT hub.
 *
 * @layer
 * @provides Azure.IoTHub.ExportDevices
 */
export const ExportDevicesHttp = Layer.effect(
  ExportDevices,
  makeIotHubActionBinding({
    tag: "Azure.IoTHub.ExportDevices",
    operation: iothub.ExportIotHubResourceDevices,
    role: IoTHubRole.ExportDevices,
  }),
);
