import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { QueryEnrollmentGroups } from "./QueryEnrollmentGroups.ts";

/**
 * Implementation of {@link QueryEnrollmentGroups} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentGroupReadRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.QueryEnrollmentGroups
 */
export const QueryEnrollmentGroupsHttp = Layer.effect(
  QueryEnrollmentGroups,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.QueryEnrollmentGroups",
    operation: dps.EnrollmentGroupQuery,
    grant: ProvisioningRole.EnrollmentGroupRead,
  }),
);
