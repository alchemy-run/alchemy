import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeviceClassSubgroup } from "./GetDeviceClassSubgroup.ts";

/**
 * Implementation of {@link GetDeviceClassSubgroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeviceClassSubgroup
 */
export const GetDeviceClassSubgroupHttp = Layer.effect(
  GetDeviceClassSubgroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeviceClassSubgroup",
    operation: adu.GetDeviceManagementDeviceClassSubgroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
