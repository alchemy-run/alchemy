import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { DeleteIndividualEnrollment } from "./DeleteIndividualEnrollment.ts";

/**
 * Implementation of {@link DeleteIndividualEnrollment} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentDeleteRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.DeleteIndividualEnrollment
 */
export const DeleteIndividualEnrollmentHttp = Layer.effect(
  DeleteIndividualEnrollment,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.DeleteIndividualEnrollment",
    operation: dps.DeleteIndividualEnrollment,
    grant: ProvisioningRole.EnrollmentDelete,
  }),
);
