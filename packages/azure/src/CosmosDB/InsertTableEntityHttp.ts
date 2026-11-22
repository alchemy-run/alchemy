import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { InsertTableEntity } from "./InsertTableEntity.ts";
import { CosmosTableRoles, makeCosmosTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link InsertTableEntity} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.InsertTableEntity
 */
export const InsertTableEntityHttp = Layer.effect(
  InsertTableEntity,
  makeCosmosTableOperationBinding({
    tag: "Azure.CosmosDB.InsertTableEntity",
    operation: tables.InsertTableEntity,
    role: CosmosTableRoles.InsertTableEntity,
  }),
);
