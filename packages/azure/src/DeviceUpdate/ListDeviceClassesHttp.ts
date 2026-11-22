import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListDeviceClasses } from "./ListDeviceClasses.ts";

/**
 * Implementation of {@link ListDeviceClasses} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListDeviceClasses
 */
export const ListDeviceClassesHttp = Layer.effect(
  ListDeviceClasses,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListDeviceClasses",
    operation: adu.ListDeviceManagementDeviceClasses,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
