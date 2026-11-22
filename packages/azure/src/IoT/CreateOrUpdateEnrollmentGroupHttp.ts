import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { CreateOrUpdateEnrollmentGroup } from "./CreateOrUpdateEnrollmentGroup.ts";

/**
 * Implementation of {@link CreateOrUpdateEnrollmentGroup} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentGroupWriteRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.CreateOrUpdateEnrollmentGroup
 */
export const CreateOrUpdateEnrollmentGroupHttp = Layer.effect(
  CreateOrUpdateEnrollmentGroup,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.CreateOrUpdateEnrollmentGroup",
    operation: dps.EnrollmentGroupCreateOrUpdate,
    grant: ProvisioningRole.EnrollmentGroupWrite,
  }),
);
