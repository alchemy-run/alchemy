import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListArtifacts } from "./ListArtifacts.ts";

/**
 * Implementation of {@link ListArtifacts} over the distilled `synapse-data`
 * data plane. Assigns the Synapse role **Synapse Artifact User** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListArtifacts
 */
export const ListArtifactsHttp = Layer.effect(
  ListArtifacts,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListArtifacts",
    operation: syms.ListArtifacts,
    grant: LakeDatabaseRole.Read,
  }),
);
