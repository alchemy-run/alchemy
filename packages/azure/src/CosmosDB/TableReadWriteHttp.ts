import * as Layer from "effect/Layer";
import { CosmosTableRoles, makeCosmosTableBinding } from "./TableBindingHttp.ts";
import { TableReadWrite } from "./TableReadWrite.ts";

/**
 * Implementation of {@link TableReadWrite} over the distilled `cosmos-tables` data
 * plane. Assigns the binding's Cosmos DB data role on the table.
 *
 * @layer
 * @provides Azure.CosmosDB.TableReadWrite
 */
export const TableReadWriteHttp = Layer.effect(
  TableReadWrite,
  makeCosmosTableBinding({
    tag: "Azure.CosmosDB.TableReadWrite",
    role: CosmosTableRoles.TableReadWrite,
    makeClient: (helpers, address) => ({
      ...helpers.makeRead(address),
      ...helpers.makeWrite(address),
    }),
  }),
);
