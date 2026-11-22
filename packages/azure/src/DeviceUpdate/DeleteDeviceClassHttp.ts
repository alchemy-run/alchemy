import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { DeleteDeviceClass } from "./DeleteDeviceClass.ts";

/**
 * Implementation of {@link DeleteDeviceClass} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.DeleteDeviceClass
 */
export const DeleteDeviceClassHttp = Layer.effect(
  DeleteDeviceClass,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.DeleteDeviceClass",
    operation: adu.DeleteDeviceManagementDeviceClass,
    grant: DeviceUpdateRole.ManagementDelete,
  }),
);
