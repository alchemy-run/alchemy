import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListDeviceClassSubgroupsForGroup } from "./ListDeviceClassSubgroupsForGroup.ts";

/**
 * Implementation of {@link ListDeviceClassSubgroupsForGroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListDeviceClassSubgroupsForGroup
 */
export const ListDeviceClassSubgroupsForGroupHttp = Layer.effect(
  ListDeviceClassSubgroupsForGroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListDeviceClassSubgroupsForGroup",
    operation: adu.ListDeviceManagementDeviceClassSubgroupsForGroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
