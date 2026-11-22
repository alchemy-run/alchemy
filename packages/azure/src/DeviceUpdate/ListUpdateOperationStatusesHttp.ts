import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListUpdateOperationStatuses } from "./ListUpdateOperationStatuses.ts";

/**
 * Implementation of {@link ListUpdateOperationStatuses} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListUpdateOperationStatuses
 */
export const ListUpdateOperationStatusesHttp = Layer.effect(
  ListUpdateOperationStatuses,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListUpdateOperationStatuses",
    operation: adu.ListDeviceUpdateOperationStatuses,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
