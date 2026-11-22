import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListLogCollections } from "./ListLogCollections.ts";

/**
 * Implementation of {@link ListLogCollections} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListLogCollections
 */
export const ListLogCollectionsHttp = Layer.effect(
  ListLogCollections,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListLogCollections",
    operation: adu.ListDeviceManagementLogCollections,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
