import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { PutArtifactInDB } from "./PutArtifactInDB.ts";

/**
 * Implementation of {@link PutArtifactInDB} over the distilled `synapse-data`
 * data plane. Assigns the Synapse role **Synapse Artifact Publisher** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.PutArtifactInDB
 */
export const PutArtifactInDBHttp = Layer.effect(
  PutArtifactInDB,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.PutArtifactInDB",
    operation: syms.PutArtifactInDB,
    grant: LakeDatabaseRole.Write,
  }),
);
