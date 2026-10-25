import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListUpdateProviders } from "./ListUpdateProviders.ts";

/**
 * Implementation of {@link ListUpdateProviders} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListUpdateProviders
 */
export const ListUpdateProvidersHttp = Layer.effect(
  ListUpdateProviders,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListUpdateProviders",
    operation: adu.ListDeviceUpdateProviders,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
