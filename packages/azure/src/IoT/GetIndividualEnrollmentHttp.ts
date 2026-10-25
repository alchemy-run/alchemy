import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { GetIndividualEnrollment } from "./GetIndividualEnrollment.ts";

/**
 * Implementation of {@link GetIndividualEnrollment} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentReadRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.GetIndividualEnrollment
 */
export const GetIndividualEnrollmentHttp = Layer.effect(
  GetIndividualEnrollment,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.GetIndividualEnrollment",
    operation: dps.GetIndividualEnrollment,
    grant: ProvisioningRole.EnrollmentRead,
  }),
);
