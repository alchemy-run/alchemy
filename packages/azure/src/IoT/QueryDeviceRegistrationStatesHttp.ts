import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { QueryDeviceRegistrationStates } from "./QueryDeviceRegistrationStates.ts";

/**
 * Implementation of {@link QueryDeviceRegistrationStates} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsRegistrationStateReadRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.QueryDeviceRegistrationStates
 */
export const QueryDeviceRegistrationStatesHttp = Layer.effect(
  QueryDeviceRegistrationStates,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.QueryDeviceRegistrationStates",
    operation: dps.DeviceRegistrationStateQuery,
    grant: ProvisioningRole.RegistrationStateRead,
  }),
);
