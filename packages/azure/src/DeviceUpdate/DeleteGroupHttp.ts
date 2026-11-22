import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { DeleteGroup } from "./DeleteGroup.ts";

/**
 * Implementation of {@link DeleteGroup} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.DeleteGroup
 */
export const DeleteGroupHttp = Layer.effect(
  DeleteGroup,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.DeleteGroup",
    operation: adu.DeleteDeviceManagementGroup,
    grant: DeviceUpdateRole.ManagementDelete,
  }),
);
