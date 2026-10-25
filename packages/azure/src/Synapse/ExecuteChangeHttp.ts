import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ExecuteChange } from "./ExecuteChange.ts";

/**
 * Implementation of {@link ExecuteChange} over the distilled `synapse-data`
 * data plane. Assigns the Synapse role **Synapse Artifact Publisher** on the
 * workspace.
 *
 * @layer
 * @provides Azure.Synapse.ExecuteChange
 */
export const ExecuteChangeHttp = Layer.effect(
  ExecuteChange,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ExecuteChange",
    operation: syms.ExecuteChange,
    grant: LakeDatabaseRole.Write,
  }),
);
