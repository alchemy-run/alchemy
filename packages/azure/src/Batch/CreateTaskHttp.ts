import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { CreateTask } from "./CreateTask.ts";

/**
 * Implementation of {@link CreateTask} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.CreateTask
 */
export const CreateTaskHttp = Layer.effect(
  CreateTask,
  makeBatchAccountBinding({
    tag: "Azure.Batch.CreateTask",
    operation: batch.CreateTaskTask,
    grants: [BatchRole.WriteJobs],
  }),
);
