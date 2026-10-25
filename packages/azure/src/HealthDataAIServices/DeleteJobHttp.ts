import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { DeleteJob } from "./DeleteJob.ts";

/**
 * Implementation of {@link DeleteJob} over the distilled
 * `healthdataaiservices-data` data plane. Assigns the custom
 * `AzureDeidBatchDeleteRole` on the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.DeleteJob
 */
export const DeleteJobHttp = Layer.effect(
  DeleteJob,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.DeleteJob",
    operation: deid.DeleteJob,
    grant: DeidRole.BatchDelete,
  }),
);
