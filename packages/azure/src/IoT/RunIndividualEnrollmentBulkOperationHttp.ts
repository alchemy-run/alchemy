import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { RunIndividualEnrollmentBulkOperation } from "./RunIndividualEnrollmentBulkOperation.ts";

/**
 * Implementation of {@link RunIndividualEnrollmentBulkOperation} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentBulkRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.RunIndividualEnrollmentBulkOperation
 */
export const RunIndividualEnrollmentBulkOperationHttp = Layer.effect(
  RunIndividualEnrollmentBulkOperation,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.RunIndividualEnrollmentBulkOperation",
    operation: dps.IndividualEnrollmentRunBulkOperation,
    grant: ProvisioningRole.EnrollmentBulk,
  }),
);
