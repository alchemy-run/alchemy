import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Layer from "effect/Layer";
import { makeProvisioningHttpBinding, ProvisioningRole } from "./BindingHttp.ts";
import { RunEnrollmentGroupBulkOperation } from "./RunEnrollmentGroupBulkOperation.ts";

/**
 * Implementation of {@link RunEnrollmentGroupBulkOperation} over the distilled
 * `deviceprovisioning-data` service API. Assigns the custom
 * `AzureDpsEnrollmentGroupBulkRole` on the provisioning service.
 *
 * @layer
 * @provides Azure.IoT.RunEnrollmentGroupBulkOperation
 */
export const RunEnrollmentGroupBulkOperationHttp = Layer.effect(
  RunEnrollmentGroupBulkOperation,
  makeProvisioningHttpBinding({
    tag: "Azure.IoT.RunEnrollmentGroupBulkOperation",
    operation: dps.EnrollmentGroupRunBulkOperation,
    grant: ProvisioningRole.EnrollmentGroupBulk,
  }),
);
