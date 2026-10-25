import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { DeleteTableEntity } from "./DeleteTableEntity.ts";
import { makeTableOperationBinding } from "./TableBindingHttp.ts";
import { TableDataAction } from "./TableTypes.ts";

/**
 * Implementation of {@link DeleteTableEntity} over the distilled
 * `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.DeleteTableEntity
 */
export const DeleteTableEntityHttp = Layer.effect(
  DeleteTableEntity,
  makeTableOperationBinding({
    tag: "Azure.Storage.DeleteTableEntity",
    operation: tables.DeleteTableEntity,
    grant: {
      customRole: "AzureStorageTableDeleteEntityRole",
      description:
        "Delete entities from Azure Table storage tables (Alchemy DeleteTableEntity binding).",
      permissions: { dataActions: [TableDataAction.delete] },
    },
  }),
);
