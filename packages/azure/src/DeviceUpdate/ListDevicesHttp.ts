import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListDevices } from "./ListDevices.ts";

/**
 * Implementation of {@link ListDevices} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListDevices
 */
export const ListDevicesHttp = Layer.effect(
  ListDevices,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListDevices",
    operation: adu.ListDeviceManagementDevices,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
