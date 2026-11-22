import * as Layer from "effect/Layer";
import { makeTableBinding } from "./TableBindingHttp.ts";
import { TableReadWrite } from "./TableReadWrite.ts";
import { TableDataAction } from "./TableTypes.ts";

/**
 * Implementation of {@link TableReadWrite} over the distilled
 * `cosmos-tables` data plane. Assigns a custom role with the entity read,
 * add, update, and delete data actions on the table.
 *
 * @layer
 * @provides Azure.Storage.TableReadWrite
 */
export const TableReadWriteHttp = Layer.effect(
  TableReadWrite,
  makeTableBinding({
    tag: "Azure.Storage.TableReadWrite",
    grant: {
      customRole: "AzureStorageTableReadWriteRole",
      description:
        "Read, insert, update, and delete entities in Azure Table storage tables (Alchemy TableReadWrite binding).",
      permissions: {
        dataActions: [
          TableDataAction.read,
          TableDataAction.add,
          TableDataAction.update,
          TableDataAction.delete,
        ],
      },
    },
    makeClient: (helpers, address) => ({
      ...helpers.makeRead(address),
      ...helpers.makeWrite(address),
    }),
  }),
);
