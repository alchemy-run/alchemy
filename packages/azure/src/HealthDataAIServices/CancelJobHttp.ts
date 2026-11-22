import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { CancelJob } from "./CancelJob.ts";

/**
 * Implementation of {@link CancelJob} over the distilled
 * `healthdataaiservices-data` data plane. Assigns the custom
 * `AzureDeidBatchWriteRole` on the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.CancelJob
 */
export const CancelJobHttp = Layer.effect(
  CancelJob,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.CancelJob",
    operation: deid.CancelJob,
    grant: DeidRole.BatchWrite,
  }),
);
