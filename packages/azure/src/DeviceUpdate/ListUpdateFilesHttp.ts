import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { ListUpdateFiles } from "./ListUpdateFiles.ts";

/**
 * Implementation of {@link ListUpdateFiles} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateUpdatesReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.ListUpdateFiles
 */
export const ListUpdateFilesHttp = Layer.effect(
  ListUpdateFiles,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.ListUpdateFiles",
    operation: adu.ListDeviceUpdateFiles,
    grant: DeviceUpdateRole.UpdatesRead,
  }),
);
