import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

/**
 * Implementation of {@link ListJobs} over the distilled
 * `healthdataaiservices-data` data plane. Assigns **DeID Batch Data Reader** on
 * the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.ListJobs
 */
export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.ListJobs",
    operation: deid.ListJobs,
    grant: DeidRole.BatchReader,
  }),
);
