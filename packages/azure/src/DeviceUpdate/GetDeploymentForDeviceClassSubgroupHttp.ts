import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeploymentForDeviceClassSubgroup } from "./GetDeploymentForDeviceClassSubgroup.ts";

/**
 * Implementation of {@link GetDeploymentForDeviceClassSubgroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeploymentForDeviceClassSubgroup
 */
export const GetDeploymentForDeviceClassSubgroupHttp = Layer.effect(
  GetDeploymentForDeviceClassSubgroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeploymentForDeviceClassSubgroup",
    operation: adu.GetDeviceManagementDeploymentForDeviceClassSubgroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
