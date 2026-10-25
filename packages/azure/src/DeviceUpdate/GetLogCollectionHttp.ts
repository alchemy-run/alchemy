import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetLogCollection } from "./GetLogCollection.ts";

/**
 * Implementation of {@link GetLogCollection} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetLogCollection
 */
export const GetLogCollectionHttp = Layer.effect(
  GetLogCollection,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetLogCollection",
    operation: adu.GetDeviceManagementLogCollection,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
