import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDevice } from "./GetDevice.ts";

/**
 * Implementation of {@link GetDevice} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDevice
 */
export const GetDeviceHttp = Layer.effect(
  GetDevice,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDevice",
    operation: adu.GetDeviceManagementDevice,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
