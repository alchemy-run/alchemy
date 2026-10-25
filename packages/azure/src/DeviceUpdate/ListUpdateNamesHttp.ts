import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListUpdateNames } from "./ListUpdateNames.ts";

/**
 * Implementation of {@link ListUpdateNames} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListUpdateNames
 */
export const ListUpdateNamesHttp = Layer.effect(
  ListUpdateNames,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListUpdateNames",
    operation: adu.ListDeviceUpdateNames,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
