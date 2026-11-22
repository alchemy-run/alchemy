import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { GetIndividualEnrollmentAttestationMechanism } from "./GetIndividualEnrollmentAttestationMechanism.ts";

/**
 * Implementation of {@link GetIndividualEnrollmentAttestationMechanism} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsAttestationDetailsRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.GetIndividualEnrollmentAttestationMechanism
 */
export const GetIndividualEnrollmentAttestationMechanismHttp = Layer.effect(
  GetIndividualEnrollmentAttestationMechanism,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.GetIndividualEnrollmentAttestationMechanism",
    operation: dps.GetIndividualEnrollmentAttestationMechanism,
    grant: ProvisioningRole.AttestationDetails,
  }),
);
