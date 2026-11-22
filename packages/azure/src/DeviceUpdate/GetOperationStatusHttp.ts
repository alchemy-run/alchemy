import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetOperationStatus } from "./GetOperationStatus.ts";

/**
 * Implementation of {@link GetOperationStatus} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetOperationStatus
 */
export const GetOperationStatusHttp = Layer.effect(
  GetOperationStatus,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetOperationStatus",
    operation: adu.GetDeviceManagementOperationStatus,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
