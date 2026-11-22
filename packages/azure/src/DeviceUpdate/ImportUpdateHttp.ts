import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ImportUpdate } from "./ImportUpdate.ts";

/**
 * Implementation of {@link ImportUpdate} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ImportUpdate
 */
export const ImportUpdateHttp = Layer.effect(
  ImportUpdate,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ImportUpdate",
    operation: adu.DeviceUpdateImportUpdate,
    grant: DeviceUpdateRole.UpdatesWrite,
  }),
);
