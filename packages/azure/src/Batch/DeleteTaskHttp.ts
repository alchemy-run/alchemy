import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { DeleteTask } from "./DeleteTask.ts";

/**
 * Implementation of {@link DeleteTask} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchDeleteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.DeleteTask
 */
export const DeleteTaskHttp = Layer.effect(
  DeleteTask,
  makeBatchAccountBinding({
    tag: "Azure.Batch.DeleteTask",
    operation: batch.DeleteTaskTask,
    grants: [BatchRole.DeleteJobs],
  }),
);
