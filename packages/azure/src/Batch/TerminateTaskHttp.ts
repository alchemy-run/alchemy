import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { TerminateTask } from "./TerminateTask.ts";

/**
 * Implementation of {@link TerminateTask} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.TerminateTask
 */
export const TerminateTaskHttp = Layer.effect(
  TerminateTask,
  makeBatchAccountBinding({
    tag: "Azure.Batch.TerminateTask",
    operation: batch.TerminateTaskTask,
    grants: [BatchRole.WriteJobs],
  }),
);
