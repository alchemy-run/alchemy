import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { MergeTableEntity } from "./MergeTableEntity.ts";
import { makeTableOperationBinding } from "./TableBindingHttp.ts";
import { TableDataAction } from "./TableTypes.ts";

/**
 * Implementation of {@link MergeTableEntity} over the distilled
 * `cosmos-tables` data
 * plane. Assigns a custom role with only the actions the operation needs
 * (see the binding).
 *
 * @layer
 * @provides Azure.Storage.MergeTableEntity
 */
export const MergeTableEntityHttp = Layer.effect(
  MergeTableEntity,
  makeTableOperationBinding({
    tag: "Azure.Storage.MergeTableEntity",
    operation: tables.MergeTableEntity,
    grant: {
      customRole: "AzureStorageTableUpsertEntityRole",
      description:
        "Insert, replace, or merge entities in Azure Table storage tables (Alchemy UpdateTableEntity / MergeTableEntity bindings).",
      permissions: { dataActions: [TableDataAction.add, TableDataAction.update] },
    },
  }),
);
