import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { DeleteTable } from "./DeleteTable.ts";
import { makeTableServiceOperationBinding } from "./TableBindingHttp.ts";
import { TableAction } from "./TableTypes.ts";

/**
 * Implementation of {@link DeleteTable} over the distilled `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.DeleteTable
 */
export const DeleteTableHttp = Layer.effect(
  DeleteTable,
  makeTableServiceOperationBinding({
    tag: "Azure.Storage.DeleteTable",
    operation: tables.DeleteTable,
    grant: {
      customRole: "AzureStorageDeleteTableRole",
      description: "Delete tables from Azure Storage accounts (Alchemy DeleteTable binding).",
      permissions: { actions: [TableAction.delete] },
    },
  }),
);
