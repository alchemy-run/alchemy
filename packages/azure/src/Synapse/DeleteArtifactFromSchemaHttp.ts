import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { DeleteArtifactFromSchema } from "./DeleteArtifactFromSchema.ts";

/**
 * Implementation of {@link DeleteArtifactFromSchema} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact
 * Publisher** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.DeleteArtifactFromSchema
 */
export const DeleteArtifactFromSchemaHttp = Layer.effect(
  DeleteArtifactFromSchema,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.DeleteArtifactFromSchema",
    operation: syms.DeleteArtifactFromSchema,
    grant: LakeDatabaseRole.Write,
  }),
);
