import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { PutDatabase } from "./PutDatabase.ts";

/**
 * Implementation of {@link PutDatabase} over the distilled `synapse-data` data
 * plane. Assigns the Synapse role **Synapse Artifact Publisher** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.PutDatabase
 */
export const PutDatabaseHttp = Layer.effect(
  PutDatabase,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.PutDatabase",
    operation: syms.PutDatabase,
    grant: LakeDatabaseRole.Write,
  }),
);
