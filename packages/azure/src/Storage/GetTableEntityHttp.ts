import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { GetTableEntity } from "./GetTableEntity.ts";
import { makeTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link GetTableEntity} over the distilled
 * `cosmos-tables` data
 * plane. Assigns **Storage Table Data Reader** on the table.
 *
 * @layer
 * @provides Azure.Storage.GetTableEntity
 */
export const GetTableEntityHttp = Layer.effect(
  GetTableEntity,
  makeTableOperationBinding({
    tag: "Azure.Storage.GetTableEntity",
    operation: tables.TableQueryEntityWithPartitionAndRowKey,
    grant: { builtInRole: BuiltInRole.StorageTableDataReader },
  }),
);
