import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

/**
 * Implementation of {@link GetJob} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.GetJob
 */
export const GetJobHttp = Layer.effect(
  GetJob,
  makeBatchAccountBinding({
    tag: "Azure.Batch.GetJob",
    operation: batch.GetJobJob,
    grants: [BatchRole.ReadJobs],
  }),
);
