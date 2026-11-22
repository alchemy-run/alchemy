import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { DeleteUpdate } from "./DeleteUpdate.ts";

/**
 * Implementation of {@link DeleteUpdate} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.DeleteUpdate
 */
export const DeleteUpdateHttp = Layer.effect(
  DeleteUpdate,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.DeleteUpdate",
    operation: adu.DeviceUpdateDeleteUpdate,
    grant: DeviceUpdateRole.UpdatesDelete,
  }),
);
