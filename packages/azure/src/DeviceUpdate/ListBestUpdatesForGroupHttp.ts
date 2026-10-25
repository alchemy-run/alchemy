import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListBestUpdatesForGroup } from "./ListBestUpdatesForGroup.ts";

/**
 * Implementation of {@link ListBestUpdatesForGroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListBestUpdatesForGroup
 */
export const ListBestUpdatesForGroupHttp = Layer.effect(
  ListBestUpdatesForGroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListBestUpdatesForGroup",
    operation: adu.ListDeviceManagementBestUpdatesForGroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
