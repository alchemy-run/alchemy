import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { GetArtifactFromDB } from "./GetArtifactFromDB.ts";

/**
 * Implementation of {@link GetArtifactFromDB} over the distilled `synapse-data`
 * data plane. Assigns the Synapse role **Synapse Artifact User** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.GetArtifactFromDB
 */
export const GetArtifactFromDBHttp = Layer.effect(
  GetArtifactFromDB,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.GetArtifactFromDB",
    operation: syms.GetArtifactFromDB,
    grant: LakeDatabaseRole.Read,
  }),
);
