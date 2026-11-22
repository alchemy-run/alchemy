import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

/**
 * Implementation of {@link ListJobs} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.ListJobs
 */
export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeBatchAccountBinding({
    tag: "Azure.Batch.ListJobs",
    operation: batch.ListJobJobs,
    grants: [BatchRole.ReadJobs],
  }),
);
