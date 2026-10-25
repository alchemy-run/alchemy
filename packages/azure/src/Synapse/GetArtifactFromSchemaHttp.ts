import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { GetArtifactFromSchema } from "./GetArtifactFromSchema.ts";

/**
 * Implementation of {@link GetArtifactFromSchema} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact User**
 * on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.GetArtifactFromSchema
 */
export const GetArtifactFromSchemaHttp = Layer.effect(
  GetArtifactFromSchema,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.GetArtifactFromSchema",
    operation: syms.GetArtifactFromSchema,
    grant: LakeDatabaseRole.Read,
  }),
);
