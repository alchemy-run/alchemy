import * as batch from "@distilled.cloud/azure/batch-data";
import * as Layer from "effect/Layer";
import { BatchRole, makeBatchAccountBinding } from "./BindingHttp.ts";
import { GetPool } from "./GetPool.ts";

/**
 * Implementation of {@link GetPool} over the distilled `batch-data` data
 * plane. Assigns the custom `AzureBatchReadPoolsRole` on the account.
 *
 * @layer
 * @provides Azure.Batch.GetPool
 */
export const GetPoolHttp = Layer.effect(
  GetPool,
  makeBatchAccountBinding({
    tag: "Azure.Batch.GetPool",
    operation: batch.GetPoolPool,
    grants: [BatchRole.ReadPools],
  }),
);
