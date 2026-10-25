import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListGroups } from "./ListGroups.ts";

/**
 * Implementation of {@link ListGroups} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListGroups
 */
export const ListGroupsHttp = Layer.effect(
  ListGroups,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListGroups",
    operation: adu.ListDeviceManagementGroups,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
