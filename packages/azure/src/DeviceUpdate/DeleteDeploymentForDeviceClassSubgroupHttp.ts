import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { DeleteDeploymentForDeviceClassSubgroup } from "./DeleteDeploymentForDeviceClassSubgroup.ts";

/**
 * Implementation of {@link DeleteDeploymentForDeviceClassSubgroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.DeleteDeploymentForDeviceClassSubgroup
 */
export const DeleteDeploymentForDeviceClassSubgroupHttp = Layer.effect(
  DeleteDeploymentForDeviceClassSubgroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.DeleteDeploymentForDeviceClassSubgroup",
    operation: adu.DeleteDeviceManagementDeploymentForDeviceClassSubgroup,
    grant: DeviceUpdateRole.ManagementDelete,
  }),
);
