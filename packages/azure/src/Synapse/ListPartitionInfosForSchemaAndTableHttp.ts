import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListPartitionInfosForSchemaAndTable } from "./ListPartitionInfosForSchemaAndTable.ts";

/**
 * Implementation of {@link ListPartitionInfosForSchemaAndTable} over the
 * distilled `synapse-data` data plane. Assigns the Synapse role **Synapse
 * Artifact User** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListPartitionInfosForSchemaAndTable
 */
export const ListPartitionInfosForSchemaAndTableHttp = Layer.effect(
  ListPartitionInfosForSchemaAndTable,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListPartitionInfosForSchemaAndTable",
    operation: syms.ListPartitionInfosForSchemaAndTable,
    grant: LakeDatabaseRole.Read,
  }),
);
