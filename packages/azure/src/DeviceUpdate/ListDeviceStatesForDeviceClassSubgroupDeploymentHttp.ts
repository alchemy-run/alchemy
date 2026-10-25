import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListDeviceStatesForDeviceClassSubgroupDeployment } from "./ListDeviceStatesForDeviceClassSubgroupDeployment.ts";

/**
 * Implementation of {@link ListDeviceStatesForDeviceClassSubgroupDeployment} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListDeviceStatesForDeviceClassSubgroupDeployment
 */
export const ListDeviceStatesForDeviceClassSubgroupDeploymentHttp = Layer.effect(
  ListDeviceStatesForDeviceClassSubgroupDeployment,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListDeviceStatesForDeviceClassSubgroupDeployment",
    operation: adu.ListDeviceManagementDeviceStatesForDeviceClassSubgroupDeployment,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
