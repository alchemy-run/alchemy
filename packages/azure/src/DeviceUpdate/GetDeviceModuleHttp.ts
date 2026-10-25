import * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Layer from "effect/Layer";
import { DeviceUpdateRole, makeDeviceUpdateHttpBinding } from "./BindingHttp.ts";
import { GetDeviceModule } from "./GetDeviceModule.ts";

/**
 * Implementation of {@link GetDeviceModule} over the distilled `deviceupdate-data`
 * data plane. Assigns the custom `AzureDeviceUpdateManagementReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DeviceUpdate.GetDeviceModule
 */
export const GetDeviceModuleHttp = Layer.effect(
  GetDeviceModule,
  makeDeviceUpdateHttpBinding({
    tag: "Azure.DeviceUpdate.GetDeviceModule",
    operation: adu.GetDeviceManagementDeviceModule,
    grant: DeviceUpdateRole.ManagementRead,
  }),
);
