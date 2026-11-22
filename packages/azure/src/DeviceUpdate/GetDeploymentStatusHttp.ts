import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeploymentStatus } from "./GetDeploymentStatus.ts";

/**
 * Implementation of {@link GetDeploymentStatus} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeploymentStatus
 */
export const GetDeploymentStatusHttp = Layer.effect(
  GetDeploymentStatus,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeploymentStatus",
    operation: adu.GetDeviceManagementDeploymentStatus,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
