import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { DeleteArtifactForDB } from "./DeleteArtifactForDB.ts";

/**
 * Implementation of {@link DeleteArtifactForDB} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact
 * Publisher** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.DeleteArtifactForDB
 */
export const DeleteArtifactForDBHttp = Layer.effect(
  DeleteArtifactForDB,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.DeleteArtifactForDB",
    operation: syms.DeleteArtifactForDB,
    grant: LakeDatabaseRole.Write,
  }),
);
