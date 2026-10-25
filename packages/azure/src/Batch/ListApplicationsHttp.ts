import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { ListApplications } from "./ListApplications.ts";

/**
 * Implementation of {@link ListApplications} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadApplicationsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.ListApplications
 */
export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeBatchAccountBinding({
    tag: "Azure.Batch.ListApplications",
    operation: batch.ListApplicationApplications,
    grants: [BatchRole.ReadApplications],
  }),
);
