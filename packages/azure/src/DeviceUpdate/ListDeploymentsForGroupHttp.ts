import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListDeploymentsForGroup } from "./ListDeploymentsForGroup.ts";

/**
 * Implementation of {@link ListDeploymentsForGroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListDeploymentsForGroup
 */
export const ListDeploymentsForGroupHttp = Layer.effect(
  ListDeploymentsForGroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListDeploymentsForGroup",
    operation: adu.ListDeviceManagementDeploymentsForGroup,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
