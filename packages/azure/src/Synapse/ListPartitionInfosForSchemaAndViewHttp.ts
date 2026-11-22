import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListPartitionInfosForSchemaAndView } from "./ListPartitionInfosForSchemaAndView.ts";

/**
 * Implementation of {@link ListPartitionInfosForSchemaAndView} over the
 * distilled `synapse-data` data plane. Assigns the Synapse role **Synapse
 * Artifact User** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListPartitionInfosForSchemaAndView
 */
export const ListPartitionInfosForSchemaAndViewHttp = Layer.effect(
  ListPartitionInfosForSchemaAndView,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListPartitionInfosForSchemaAndView",
    operation: syms.ListPartitionInfosForSchemaAndView,
    grant: LakeDatabaseRole.Read,
  }),
);
