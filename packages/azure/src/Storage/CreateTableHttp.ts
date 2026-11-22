import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { CreateTable } from "./CreateTable.ts";
import { makeTableServiceOperationBinding } from "./TableBindingHttp.ts";
import { TableAction } from "./TableTypes.ts";

/**
 * Implementation of {@link CreateTable} over the distilled `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.CreateTable
 */
export const CreateTableHttp = Layer.effect(
  CreateTable,
  makeTableServiceOperationBinding({
    tag: "Azure.Storage.CreateTable",
    operation: tables.CreateTable,
    grant: {
      customRole: "AzureStorageCreateTableRole",
      description: "Create tables in Azure Storage accounts (Alchemy CreateTable binding).",
      permissions: { actions: [TableAction.write] },
    },
  }),
);
