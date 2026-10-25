import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { QueryTableEntities } from "./QueryTableEntities.ts";
import { CosmosTableRoles, makeCosmosTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link QueryTableEntities} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.QueryTableEntities
 */
export const QueryTableEntitiesHttp = Layer.effect(
  QueryTableEntities,
  makeCosmosTableOperationBinding({
    tag: "Azure.CosmosDB.QueryTableEntities",
    operation: tables.TableQueryEntities,
    role: CosmosTableRoles.QueryTableEntities,
  }),
);
