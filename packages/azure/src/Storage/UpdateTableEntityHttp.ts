import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { makeTableOperationBinding } from "./TableBindingHttp.ts";
import { TableDataAction } from "./TableTypes.ts";
import { UpdateTableEntity } from "./UpdateTableEntity.ts";

/**
 * Implementation of {@link UpdateTableEntity} over the distilled
 * `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.UpdateTableEntity
 */
export const UpdateTableEntityHttp = Layer.effect(
  UpdateTableEntity,
  makeTableOperationBinding({
    tag: "Azure.Storage.UpdateTableEntity",
    operation: tables.UpdateTableEntity,
    grant: {
      customRole: "AzureStorageTableUpsertEntityRole",
      description:
        "Insert, replace, or merge entities in Azure Table storage tables (Alchemy UpdateTableEntity / MergeTableEntity bindings).",
      permissions: { dataActions: [TableDataAction.add, TableDataAction.update] },
    },
  }),
);
