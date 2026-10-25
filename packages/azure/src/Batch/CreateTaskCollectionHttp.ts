import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { CreateTaskCollection } from "./CreateTaskCollection.ts";

/**
 * Implementation of {@link CreateTaskCollection} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchWriteJobsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.CreateTaskCollection
 */
export const CreateTaskCollectionHttp = Layer.effect(
  CreateTaskCollection,
  makeBatchAccountBinding({
    tag: "Azure.Batch.CreateTaskCollection",
    operation: batch.CreateTaskTaskCollection,
    grants: [BatchRole.WriteJobs],
  }),
);
