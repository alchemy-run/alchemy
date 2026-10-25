import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

/**
 * Implementation of {@link GetJob} over the distilled
 * `healthdataaiservices-data` data plane. Assigns **DeID Batch Data Reader** on
 * the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.GetJob
 */
export const GetJobHttp = Layer.effect(
  GetJob,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.GetJob",
    operation: deid.GetJob,
    grant: DeidRole.BatchReader,
  }),
);
