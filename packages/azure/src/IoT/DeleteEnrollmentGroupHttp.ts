import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { DeleteEnrollmentGroup } from "./DeleteEnrollmentGroup.ts";

/**
 * Implementation of {@link DeleteEnrollmentGroup} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentGroupDeleteRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.DeleteEnrollmentGroup
 */
export const DeleteEnrollmentGroupHttp = Layer.effect(
  DeleteEnrollmentGroup,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.DeleteEnrollmentGroup",
    operation: dps.DeleteEnrollmentGroup,
    grant: ProvisioningRole.EnrollmentGroupDelete,
  }),
);
