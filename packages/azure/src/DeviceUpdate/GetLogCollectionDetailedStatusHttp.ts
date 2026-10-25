import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetLogCollectionDetailedStatus } from "./GetLogCollectionDetailedStatus.ts";

/**
 * Implementation of {@link GetLogCollectionDetailedStatus} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetLogCollectionDetailedStatus
 */
export const GetLogCollectionDetailedStatusHttp = Layer.effect(
  GetLogCollectionDetailedStatus,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetLogCollectionDetailedStatus",
    operation: adu.GetDeviceManagementLogCollectionDetailedStatus,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
