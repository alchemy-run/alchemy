import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { DeleteDeviceClassSubgroup } from "./DeleteDeviceClassSubgroup.ts";

/**
 * Implementation of {@link DeleteDeviceClassSubgroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.DeleteDeviceClassSubgroup
 */
export const DeleteDeviceClassSubgroupHttp = Layer.effect(
  DeleteDeviceClassSubgroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.DeleteDeviceClassSubgroup",
    operation: adu.DeleteDeviceManagementDeviceClassSubgroup,
    grant: DeviceUpdateRole.ManagementDelete,
  }),
);
