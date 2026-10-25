import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { StopDeployment } from "./StopDeployment.ts";

/**
 * Implementation of {@link StopDeployment} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.StopDeployment
 */
export const StopDeploymentHttp = Layer.effect(
  StopDeployment,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.StopDeployment",
    operation: adu.StopDeviceManagementDeployment,
    grant: DeviceUpdateRole.ManagementWrite,
  }),
);
