import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListUpdateVersions } from "./ListUpdateVersions.ts";

/**
 * Implementation of {@link ListUpdateVersions} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListUpdateVersions
 */
export const ListUpdateVersionsHttp = Layer.effect(
  ListUpdateVersions,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListUpdateVersions",
    operation: adu.ListDeviceUpdateVersions,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
