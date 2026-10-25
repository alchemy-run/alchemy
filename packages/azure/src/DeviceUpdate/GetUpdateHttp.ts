import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetUpdate } from "./GetUpdate.ts";

/**
 * Implementation of {@link GetUpdate} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetUpdate
 */
export const GetUpdateHttp = Layer.effect(
  GetUpdate,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetUpdate",
    operation: adu.DeviceUpdateGetUpdate,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
