import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetUpdateCompliance } from "./GetUpdateCompliance.ts";

/**
 * Implementation of {@link GetUpdateCompliance} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetUpdateCompliance
 */
export const GetUpdateComplianceHttp = Layer.effect(
  GetUpdateCompliance,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetUpdateCompliance",
    operation: adu.DeviceManagementGetUpdateCompliance,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
