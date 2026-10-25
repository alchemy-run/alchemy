import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { CreateOrUpdateIndividualEnrollment } from "./CreateOrUpdateIndividualEnrollment.ts";

/**
 * Implementation of {@link CreateOrUpdateIndividualEnrollment} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentWriteRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.CreateOrUpdateIndividualEnrollment
 */
export const CreateOrUpdateIndividualEnrollmentHttp = Layer.effect(
  CreateOrUpdateIndividualEnrollment,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.CreateOrUpdateIndividualEnrollment",
    operation: dps.IndividualEnrollmentCreateOrUpdate,
    grant: ProvisioningRole.EnrollmentWrite,
  }),
);
