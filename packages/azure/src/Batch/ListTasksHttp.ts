import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { ListTasks } from "./ListTasks.ts";

/**
 * Implementation of {@link ListTasks} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.ListTasks
 */
export const ListTasksHttp = Layer.effect(
  ListTasks,
  makeBatchAccountBinding({
    tag: "Azure.Batch.ListTasks",
    operation: batch.ListTaskTasks,
    grants: [BatchRole.ReadJobs],
  }),
);
