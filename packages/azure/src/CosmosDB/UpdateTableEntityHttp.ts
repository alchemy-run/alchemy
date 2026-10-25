import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { CosmosTableRoles, makeCosmosTableOperationBinding } from "./TableBindingHttp.ts";
import { UpdateTableEntity } from "./UpdateTableEntity.ts";

/**
 * Implementation of {@link UpdateTableEntity} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.UpdateTableEntity
 */
export const UpdateTableEntityHttp = Layer.effect(
  UpdateTableEntity,
  makeCosmosTableOperationBinding({
    tag: "Azure.CosmosDB.UpdateTableEntity",
    operation: tables.UpdateTableEntity,
    role: CosmosTableRoles.UpdateTableEntity,
  }),
);
