import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { UpdateDeviceClass } from "./UpdateDeviceClass.ts";

/**
 * Implementation of {@link UpdateDeviceClass} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.UpdateDeviceClass
 */
export const UpdateDeviceClassHttp = Layer.effect(
  UpdateDeviceClass,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.UpdateDeviceClass",
    operation: adu.UpdateDeviceManagementDeviceClass,
    grant: DeviceUpdateRole.ManagementWrite,
  }),
);
