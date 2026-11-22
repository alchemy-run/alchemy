import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListOperationStatuses } from "./ListOperationStatuses.ts";

/**
 * Implementation of {@link ListOperationStatuses} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListOperationStatuses
 */
export const ListOperationStatusesHttp = Layer.effect(
  ListOperationStatuses,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListOperationStatuses",
    operation: adu.ListDeviceManagementOperationStatuses,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
