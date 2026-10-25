import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { InsertTableEntity } from "./InsertTableEntity.ts";
import { makeTableOperationBinding } from "./TableBindingHttp.ts";
import { TableDataAction } from "./TableTypes.ts";

/**
 * Implementation of {@link InsertTableEntity} over the distilled
 * `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.InsertTableEntity
 */
export const InsertTableEntityHttp = Layer.effect(
  InsertTableEntity,
  makeTableOperationBinding({
    tag: "Azure.Storage.InsertTableEntity",
    operation: tables.InsertTableEntity,
    grant: {
      customRole: "AzureStorageTableInsertEntityRole",
      description:
        "Insert entities into Azure Table storage tables (Alchemy InsertTableEntity binding).",
      permissions: { dataActions: [TableDataAction.add] },
    },
  }),
);
