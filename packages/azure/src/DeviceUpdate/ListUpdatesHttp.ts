import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListUpdates } from "./ListUpdates.ts";

/**
 * Implementation of {@link ListUpdates} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListUpdates
 */
export const ListUpdatesHttp = Layer.effect(
  ListUpdates,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListUpdates",
    operation: adu.ListDeviceUpdateUpdates,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
