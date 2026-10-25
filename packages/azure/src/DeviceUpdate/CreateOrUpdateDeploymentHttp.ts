import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { CreateOrUpdateDeployment } from "./CreateOrUpdateDeployment.ts";

/**
 * Implementation of {@link CreateOrUpdateDeployment} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.CreateOrUpdateDeployment
 */
export const CreateOrUpdateDeploymentHttp = Layer.effect(
  CreateOrUpdateDeployment,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.CreateOrUpdateDeployment",
    operation: adu.DeviceManagementCreateOrUpdateDeployment,
    grant: DeviceUpdateRole.ManagementWrite,
  }),
);
