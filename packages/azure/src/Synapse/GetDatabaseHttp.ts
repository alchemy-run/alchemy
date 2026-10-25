import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { GetDatabase } from "./GetDatabase.ts";

/**
 * Implementation of {@link GetDatabase} over the distilled `synapse-data` data
 * plane. Assigns the Synapse role **Synapse Artifact User** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.GetDatabase
 */
export const GetDatabaseHttp = Layer.effect(
  GetDatabase,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.GetDatabase",
    operation: syms.GetDatabase,
    grant: LakeDatabaseRole.Read,
  }),
);
