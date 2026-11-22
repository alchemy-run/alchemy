import * as Layer from "effect/Layer";
import { CosmosTableRoles, makeCosmosTableBinding } from "./TableBindingHttp.ts";
import { TableRead } from "./TableRead.ts";

/**
 * Implementation of {@link TableRead} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.TableRead
 */
export const TableReadHttp = Layer.effect(
  TableRead,
  makeCosmosTableBinding({
    tag: "Azure.CosmosDB.TableRead",
    role: CosmosTableRoles.TableRead,
    makeClient: (helpers, address) => helpers.makeRead(address),
  }),
);
