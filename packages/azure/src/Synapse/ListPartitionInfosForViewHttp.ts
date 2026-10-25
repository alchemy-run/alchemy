import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListPartitionInfosForView } from "./ListPartitionInfosForView.ts";

/**
 * Implementation of {@link ListPartitionInfosForView} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact User**
 * on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListPartitionInfosForView
 */
export const ListPartitionInfosForViewHttp = Layer.effect(
  ListPartitionInfosForView,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListPartitionInfosForView",
    operation: syms.ListPartitionInfosForView,
    grant: LakeDatabaseRole.Read,
  }),
);
