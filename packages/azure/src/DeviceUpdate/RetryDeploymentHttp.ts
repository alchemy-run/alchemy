import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { RetryDeployment } from "./RetryDeployment.ts";

/**
 * Implementation of {@link RetryDeployment} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.RetryDeployment
 */
export const RetryDeploymentHttp = Layer.effect(
  RetryDeployment,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.RetryDeployment",
    operation: adu.RetryDeviceManagementDeployment,
    grant: DeviceUpdateRole.ManagementWrite,
  }),
);
