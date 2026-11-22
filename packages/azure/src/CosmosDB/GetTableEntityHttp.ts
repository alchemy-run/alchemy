import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { GetTableEntity } from "./GetTableEntity.ts";
import { CosmosTableRoles, makeCosmosTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link GetTableEntity} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.GetTableEntity
 */
export const GetTableEntityHttp = Layer.effect(
  GetTableEntity,
  makeCosmosTableOperationBinding({
    tag: "Azure.CosmosDB.GetTableEntity",
    operation: tables.TableQueryEntityWithPartitionAndRowKey,
    role: CosmosTableRoles.GetTableEntity,
  }),
);
