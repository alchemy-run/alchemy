import * as Layer from "effect/Layer";
import { makeTableBinding } from "./TableBindingHttp.ts";
import { TableDataAction } from "./TableTypes.ts";
import { TableWrite } from "./TableWrite.ts";

/**
 * Implementation of {@link TableWrite} over the distilled `cosmos-tables`
 * data plane. Assigns a custom role with the entity add, update, and
 * delete data actions on the table.
 *
 * @layer
 * @provides Azure.Storage.TableWrite
 */
export const TableWriteHttp = Layer.effect(
  TableWrite,
  makeTableBinding({
    tag: "Azure.Storage.TableWrite",
    grant: {
      customRole: "AzureStorageTableWriteRole",
      description:
        "Insert, update, and delete entities in Azure Table storage tables (Alchemy TableWrite binding).",
      permissions: {
        dataActions: [TableDataAction.add, TableDataAction.update, TableDataAction.delete],
      },
    },
    makeClient: (helpers, address) => helpers.makeWrite(address),
  }),
);
