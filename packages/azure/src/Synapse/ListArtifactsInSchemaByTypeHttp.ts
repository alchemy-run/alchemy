import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListArtifactsInSchemaByType } from "./ListArtifactsInSchemaByType.ts";

/**
 * Implementation of {@link ListArtifactsInSchemaByType} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact User**
 * on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListArtifactsInSchemaByType
 */
export const ListArtifactsInSchemaByTypeHttp = Layer.effect(
  ListArtifactsInSchemaByType,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListArtifactsInSchemaByType",
    operation: syms.ListArtifactsInSchemaByType,
    grant: LakeDatabaseRole.Read,
  }),
);
