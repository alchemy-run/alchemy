import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetUpdateComplianceForGroup } from "./GetUpdateComplianceForGroup.ts";

/**
 * Implementation of {@link GetUpdateComplianceForGroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetUpdateComplianceForGroup
 */
export const GetUpdateComplianceForGroupHttp = Layer.effect(
  GetUpdateComplianceForGroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetUpdateComplianceForGroup",
    operation: adu.DeviceManagementGetUpdateComplianceForGroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
