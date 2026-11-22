import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { GetJobTaskCounts } from "./GetJobTaskCounts.ts";

/**
 * Implementation of {@link GetJobTaskCounts} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.GetJobTaskCounts
 */
export const GetJobTaskCountsHttp = Layer.effect(
  GetJobTaskCounts,
  makeBatchAccountBinding({
    tag: "Azure.Batch.GetJobTaskCounts",
    operation: batch.GetJobJobTaskCounts,
    grants: [BatchRole.ReadJobs],
  }),
);
