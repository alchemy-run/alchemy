import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeviceClassSubgroupDeploymentStatus } from "./GetDeviceClassSubgroupDeploymentStatus.ts";

/**
 * Implementation of {@link GetDeviceClassSubgroupDeploymentStatus} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeviceClassSubgroupDeploymentStatus
 */
export const GetDeviceClassSubgroupDeploymentStatusHttp = Layer.effect(
  GetDeviceClassSubgroupDeploymentStatus,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeviceClassSubgroupDeploymentStatus",
    operation: adu.GetDeviceManagementDeviceClassSubgroupDeploymentStatus,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
