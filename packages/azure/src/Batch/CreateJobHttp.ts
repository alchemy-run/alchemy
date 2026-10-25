import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { CreateJob } from "./CreateJob.ts";

/**
 * Implementation of {@link CreateJob} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.CreateJob
 */
export const CreateJobHttp = Layer.effect(
  CreateJob,
  makeBatchAccountBinding({
    tag: "Azure.Batch.CreateJob",
    operation: batch.CreateJobJob,
    grants: [BatchRole.WriteJobs],
  }),
);
