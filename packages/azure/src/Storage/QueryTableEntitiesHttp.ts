import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { QueryTableEntities } from "./QueryTableEntities.ts";
import { makeTableOperationBinding } from "./TableBindingHttp.ts";

/**
 * Implementation of {@link QueryTableEntities} over the distilled
 * `cosmos-tables` data
 * plane. Assigns **Storage Table Data Reader** on the table.
 *
 * @layer
 * @provides Azure.Storage.QueryTableEntities
 */
export const QueryTableEntitiesHttp = Layer.effect(
  QueryTableEntities,
  makeTableOperationBinding({
    tag: "Azure.Storage.QueryTableEntities",
    operation: tables.TableQueryEntities,
    grant: { builtInRole: BuiltInRole.StorageTableDataReader },
  }),
);
