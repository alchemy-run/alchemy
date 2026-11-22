import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetBestUpdatesForDeviceClassSubgroup } from "./GetBestUpdatesForDeviceClassSubgroup.ts";

/**
 * Implementation of {@link GetBestUpdatesForDeviceClassSubgroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetBestUpdatesForDeviceClassSubgroup
 */
export const GetBestUpdatesForDeviceClassSubgroupHttp = Layer.effect(
  GetBestUpdatesForDeviceClassSubgroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetBestUpdatesForDeviceClassSubgroup",
    operation: adu.GetDeviceManagementBestUpdatesForDeviceClassSubgroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
