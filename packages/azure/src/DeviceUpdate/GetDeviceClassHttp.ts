import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeviceClass } from "./GetDeviceClass.ts";

/**
 * Implementation of {@link GetDeviceClass} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeviceClass
 */
export const GetDeviceClassHttp = Layer.effect(
  GetDeviceClass,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeviceClass",
    operation: adu.GetDeviceManagementDeviceClass,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
