import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { TerminateJob } from "./TerminateJob.ts";

/**
 * Implementation of {@link TerminateJob} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.TerminateJob
 */
export const TerminateJobHttp = Layer.effect(
  TerminateJob,
  makeBatchAccountBinding({
    tag: "Azure.Batch.TerminateJob",
    operation: batch.TerminateJobJob,
    grants: [BatchRole.WriteJobs],
  }),
);
