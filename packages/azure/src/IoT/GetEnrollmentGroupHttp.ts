import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { GetEnrollmentGroup } from "./GetEnrollmentGroup.ts";

/**
 * Implementation of {@link GetEnrollmentGroup} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentGroupReadRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.GetEnrollmentGroup
 */
export const GetEnrollmentGroupHttp = Layer.effect(
  GetEnrollmentGroup,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.GetEnrollmentGroup",
    operation: dps.GetEnrollmentGroup,
    grant: ProvisioningRole.EnrollmentGroupRead,
  }),
);
