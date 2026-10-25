import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { ListPools } from "./ListPools.ts";

/**
 * Implementation of {@link ListPools} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadPoolsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.ListPools
 */
export const ListPoolsHttp = Layer.effect(
  ListPools,
  makeBatchAccountBinding({
    tag: "Azure.Batch.ListPools",
    operation: batch.ListPoolPools,
    grants: [BatchRole.ReadPools],
  }),
);
