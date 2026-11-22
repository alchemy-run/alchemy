import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { ExecuteChangeWithValidation } from "./ExecuteChangeWithValidation.ts";

/**
 * Implementation of {@link ExecuteChangeWithValidation} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact
 * Publisher** on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.ExecuteChangeWithValidation
 */
export const ExecuteChangeWithValidationHttp = Layer.effect(
  ExecuteChangeWithValidation,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.ExecuteChangeWithValidation",
    operation: syms.ExecuteChangeWithValidation,
    grant: LakeDatabaseRole.Write,
  }),
);
