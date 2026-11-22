import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { PutArtifactInSchema } from "./PutArtifactInSchema.ts";

/**
 * Implementation of {@link PutArtifactInSchema} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact
 * Publisher** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.PutArtifactInSchema
 */
export const PutArtifactInSchemaHttp = Layer.effect(
  PutArtifactInSchema,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.PutArtifactInSchema",
    operation: syms.PutArtifactInSchema,
    grant: LakeDatabaseRole.Write,
  }),
);
