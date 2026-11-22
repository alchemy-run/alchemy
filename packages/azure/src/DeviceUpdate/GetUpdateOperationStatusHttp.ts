import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetUpdateOperationStatus } from "./GetUpdateOperationStatus.ts";

/**
 * Implementation of {@link GetUpdateOperationStatus} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetUpdateOperationStatus
 */
export const GetUpdateOperationStatusHttp = Layer.effect(
  GetUpdateOperationStatus,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetUpdateOperationStatus",
    operation: adu.GetDeviceUpdateOperationStatus,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
