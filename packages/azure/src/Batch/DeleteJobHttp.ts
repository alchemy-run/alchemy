import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { DeleteJob } from "./DeleteJob.ts";

/**
 * Implementation of {@link DeleteJob} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchDeleteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.DeleteJob
 */
export const DeleteJobHttp = Layer.effect(
  DeleteJob,
  makeBatchAccountBinding({
    tag: "Azure.Batch.DeleteJob",
    operation: batch.DeleteJobJob,
    grants: [BatchRole.DeleteJobs],
  }),
);
