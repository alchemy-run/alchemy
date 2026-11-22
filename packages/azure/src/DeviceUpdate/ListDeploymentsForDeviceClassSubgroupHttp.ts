import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListDeploymentsForDeviceClassSubgroup } from "./ListDeploymentsForDeviceClassSubgroup.ts";

/**
 * Implementation of {@link ListDeploymentsForDeviceClassSubgroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListDeploymentsForDeviceClassSubgroup
 */
export const ListDeploymentsForDeviceClassSubgroupHttp = Layer.effect(
  ListDeploymentsForDeviceClassSubgroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListDeploymentsForDeviceClassSubgroup",
    operation: adu.ListDeviceManagementDeploymentsForDeviceClassSubgroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
