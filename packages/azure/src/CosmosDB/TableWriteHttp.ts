import * as Layer from "effect/Layer";
import { CosmosTableRoles, makeCosmosTableBinding } from "./TableBindingHttp.ts";
import { TableWrite } from "./TableWrite.ts";

/**
 * Implementation of {@link TableWrite} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.TableWrite
 */
export const TableWriteHttp = Layer.effect(
  TableWrite,
  makeCosmosTableBinding({
    tag: "Azure.CosmosDB.TableWrite",
    role: CosmosTableRoles.TableWrite,
    makeClient: (helpers, address) => helpers.makeWrite(address),
  }),
);
