import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { DeleteTableEntity } from "./DeleteTableEntity.ts";
import { CosmosTableRoles, makeCosmosTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link DeleteTableEntity} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.DeleteTableEntity
 */
export const DeleteTableEntityHttp = Layer.effect(
  DeleteTableEntity,
  makeCosmosTableOperationBinding({
    tag: "Azure.CosmosDB.DeleteTableEntity",
    operation: tables.DeleteTableEntity,
    role: CosmosTableRoles.DeleteTableEntity,
  }),
);
