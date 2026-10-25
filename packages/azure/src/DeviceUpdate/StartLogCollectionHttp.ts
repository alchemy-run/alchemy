import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { StartLogCollection } from "./StartLogCollection.ts";

/**
 * Implementation of {@link StartLogCollection} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.StartLogCollection
 */
export const StartLogCollectionHttp = Layer.effect(
  StartLogCollection,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.StartLogCollection",
    operation: adu.StartDeviceManagementLogCollection,
    grant: DeviceUpdateRole.ManagementWrite,
  }),
);
