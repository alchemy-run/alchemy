import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { GetDeviceRegistrationState } from "./GetDeviceRegistrationState.ts";

/**
 * Implementation of {@link GetDeviceRegistrationState} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsRegistrationStateReadRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.GetDeviceRegistrationState
 */
export const GetDeviceRegistrationStateHttp = Layer.effect(
  GetDeviceRegistrationState,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.GetDeviceRegistrationState",
    operation: dps.GetDeviceRegistrationState,
    grant: ProvisioningRole.RegistrationStateRead,
  }),
);
