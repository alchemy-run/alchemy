import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetGroup } from "./GetGroup.ts";

/**
 * Implementation of {@link GetGroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetGroup
 */
export const GetGroupHttp = Layer.effect(
  GetGroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetGroup",
    operation: adu.GetDeviceManagementGroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
