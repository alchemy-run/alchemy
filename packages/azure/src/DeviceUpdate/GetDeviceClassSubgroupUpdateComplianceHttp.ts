import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeviceClassSubgroupUpdateCompliance } from "./GetDeviceClassSubgroupUpdateCompliance.ts";

/**
 * Implementation of {@link GetDeviceClassSubgroupUpdateCompliance} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeviceClassSubgroupUpdateCompliance
 */
export const GetDeviceClassSubgroupUpdateComplianceHttp = Layer.effect(
  GetDeviceClassSubgroupUpdateCompliance,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeviceClassSubgroupUpdateCompliance",
    operation: adu.DeviceManagementGetDeviceClassSubgroupUpdateCompliance,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
