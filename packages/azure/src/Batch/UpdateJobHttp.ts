import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { UpdateJob } from "./UpdateJob.ts";

/**
 * Implementation of {@link UpdateJob} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.UpdateJob
 */
export const UpdateJobHttp = Layer.effect(
  UpdateJob,
  makeBatchAccountBinding({
    tag: "Azure.Batch.UpdateJob",
    operation: batch.UpdateJobJob,
    grants: [BatchRole.WriteJobs],
  }),
);
