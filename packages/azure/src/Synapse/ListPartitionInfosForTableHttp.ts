import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListPartitionInfosForTable } from "./ListPartitionInfosForTable.ts";

/**
 * Implementation of {@link ListPartitionInfosForTable} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact User**
 * on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListPartitionInfosForTable
 */
export const ListPartitionInfosForTableHttp = Layer.effect(
  ListPartitionInfosForTable,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListPartitionInfosForTable",
    operation: syms.ListPartitionInfosForTable,
    grant: LakeDatabaseRole.Read,
  }),
);
