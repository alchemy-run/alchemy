import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { QueryIndividualEnrollments } from "./QueryIndividualEnrollments.ts";

/**
 * Implementation of {@link QueryIndividualEnrollments} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentReadRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.QueryIndividualEnrollments
 */
export const QueryIndividualEnrollmentsHttp = Layer.effect(
  QueryIndividualEnrollments,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.QueryIndividualEnrollments",
    operation: dps.IndividualEnrollmentQuery,
    grant: ProvisioningRole.EnrollmentRead,
  }),
);
