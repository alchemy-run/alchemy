import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { DeleteDeployment } from "./DeleteDeployment.ts";

/**
 * Implementation of {@link DeleteDeployment} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.DeleteDeployment
 */
export const DeleteDeploymentHttp = Layer.effect(
  DeleteDeployment,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.DeleteDeployment",
    operation: adu.DeleteDeviceManagementDeployment,
    grant: DeviceUpdateRole.ManagementDelete,
  }),
);
