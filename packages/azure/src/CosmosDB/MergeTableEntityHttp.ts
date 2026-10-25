import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { MergeTableEntity } from "./MergeTableEntity.ts";
import { CosmosTableRoles, makeCosmosTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link MergeTableEntity} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.MergeTableEntity
 */
export const MergeTableEntityHttp = Layer.effect(
  MergeTableEntity,
  makeCosmosTableOperationBinding({
    tag: "Azure.CosmosDB.MergeTableEntity",
    operation: tables.MergeTableEntity,
    role: CosmosTableRoles.MergeTableEntity,
  }),
);
