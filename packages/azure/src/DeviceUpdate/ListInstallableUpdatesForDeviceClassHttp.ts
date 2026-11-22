import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListInstallableUpdatesForDeviceClass } from "./ListInstallableUpdatesForDeviceClass.ts";

/**
 * Implementation of {@link ListInstallableUpdatesForDeviceClass} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListInstallableUpdatesForDeviceClass
 */
export const ListInstallableUpdatesForDeviceClassHttp = Layer.effect(
  ListInstallableUpdatesForDeviceClass,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListInstallableUpdatesForDeviceClass",
    operation: adu.ListDeviceManagementInstallableUpdatesForDeviceClass,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
