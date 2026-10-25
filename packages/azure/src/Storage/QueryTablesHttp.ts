import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { QueryTables } from "./QueryTables.ts";
import { makeTableServiceOperationBinding } from "./TableBindingHttp.ts";
import { TableAction } from "./TableTypes.ts";

/**
 * Implementation of {@link QueryTables} over the distilled `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.QueryTables
 */
export const QueryTablesHttp = Layer.effect(
  QueryTables,
  makeTableServiceOperationBinding({
    tag: "Azure.Storage.QueryTables",
    operation: tables.TableQuery,
    grant: {
      customRole: "AzureStorageQueryTablesRole",
      description: "List tables in Azure Storage accounts (Alchemy QueryTables binding).",
      permissions: { actions: [TableAction.read] },
    },
  }),
);
