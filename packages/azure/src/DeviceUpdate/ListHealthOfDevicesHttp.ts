import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListHealthOfDevices } from "./ListHealthOfDevices.ts";

/**
 * Implementation of {@link ListHealthOfDevices} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListHealthOfDevices
 */
export const ListHealthOfDevicesHttp = Layer.effect(
  ListHealthOfDevices,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListHealthOfDevices",
    operation: adu.ListDeviceManagementHealthOfDevices,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
