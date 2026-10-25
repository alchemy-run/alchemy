import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { GetEnrollmentGroupAttestationMechanism } from "./GetEnrollmentGroupAttestationMechanism.ts";

/**
 * Implementation of {@link GetEnrollmentGroupAttestationMechanism} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsAttestationDetailsRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.GetEnrollmentGroupAttestationMechanism
 */
export const GetEnrollmentGroupAttestationMechanismHttp = Layer.effect(
  GetEnrollmentGroupAttestationMechanism,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.GetEnrollmentGroupAttestationMechanism",
    operation: dps.GetEnrollmentGroupAttestationMechanism,
    grant: ProvisioningRole.AttestationDetails,
  }),
);
