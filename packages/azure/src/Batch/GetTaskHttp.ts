import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { GetTask } from "./GetTask.ts";

/**
 * Implementation of {@link GetTask} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.GetTask
 */
export const GetTaskHttp = Layer.effect(
  GetTask,
  makeBatchAccountBinding({
    tag: "Azure.Batch.GetTask",
    operation: batch.GetTaskTask,
    grants: [BatchRole.ReadJobs],
  }),
);
