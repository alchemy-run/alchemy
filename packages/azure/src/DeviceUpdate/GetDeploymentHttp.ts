import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeployment } from "./GetDeployment.ts";

/**
 * Implementation of {@link GetDeployment} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeployment
 */
export const GetDeploymentHttp = Layer.effect(
  GetDeployment,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeployment",
    operation: adu.GetDeviceManagementDeployment,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
