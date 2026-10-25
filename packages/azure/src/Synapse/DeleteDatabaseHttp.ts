import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { DeleteDatabase } from "./DeleteDatabase.ts";

/**
 * Implementation of {@link DeleteDatabase} over the distilled `synapse-data`
 * data plane. Assigns the Synapse role **Synapse Artifact Publisher** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.DeleteDatabase
 */
export const DeleteDatabaseHttp = Layer.effect(
  DeleteDatabase,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.DeleteDatabase",
    operation: syms.DeleteDatabase,
    grant: LakeDatabaseRole.Write,
  }),
);
