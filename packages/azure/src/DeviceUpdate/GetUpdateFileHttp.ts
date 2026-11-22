import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetUpdateFile } from "./GetUpdateFile.ts";

/**
 * Implementation of {@link GetUpdateFile} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetUpdateFile
 */
export const GetUpdateFileHttp = Layer.effect(
  GetUpdateFile,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetUpdateFile",
    operation: adu.GetDeviceUpdateFile,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
