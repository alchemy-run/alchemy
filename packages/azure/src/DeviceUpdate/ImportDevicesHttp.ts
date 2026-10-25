import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ImportDevices } from "./ImportDevices.ts";

/**
 * Implementation of {@link ImportDevices} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ImportDevices
 */
export const ImportDevicesHttp = Layer.effect(
  ImportDevices,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ImportDevices",
    operation: adu.ImportDeviceManagementDevices,
    grant: DeviceUpdateRole.ManagementWrite,
  }),
);
