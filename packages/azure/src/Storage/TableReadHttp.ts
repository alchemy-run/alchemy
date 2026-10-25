import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { makeTableBinding } from "./TableBindingHttp.ts";
import { TableRead } from "./TableRead.ts";

/**
 * Implementation of {@link TableRead} over the distilled `cosmos-tables`
 * data plane. Assigns **Storage Table Data Reader** on the table.
 *
 * @layer
 * @provides Azure.Storage.TableRead
 */
export const TableReadHttp = Layer.effect(
  TableRead,
  makeTableBinding({
    tag: "Azure.Storage.TableRead",
    grant: { builtInRole: BuiltInRole.StorageTableDataReader },
    makeClient: (helpers, address) => helpers.makeRead(address),
  }),
);
