import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { DeleteDeviceRegistrationState } from "./DeleteDeviceRegistrationState.ts";

/**
 * Implementation of {@link DeleteDeviceRegistrationState} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsRegistrationStateDeleteRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.DeleteDeviceRegistrationState
 */
export const DeleteDeviceRegistrationStateHttp = Layer.effect(
  DeleteDeviceRegistrationState,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.DeleteDeviceRegistrationState",
    operation: dps.DeleteDeviceRegistrationState,
    grant: ProvisioningRole.RegistrationStateDelete,
  }),
);
