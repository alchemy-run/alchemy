import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ListDatabases } from "./ListDatabases.ts";

/**
 * Implementation of {@link ListDatabases} over the distilled `synapse-data`
 * data plane. Assigns the Synapse role **Synapse Artifact User** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.ListDatabases
 */
export const ListDatabasesHttp = Layer.effect(
  ListDatabases,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ListDatabases",
    operation: syms.ListDatabases,
    grant: LakeDatabaseRole.Read,
  }),
);
