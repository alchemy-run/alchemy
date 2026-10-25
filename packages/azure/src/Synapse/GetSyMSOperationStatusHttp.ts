import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Layer from "effect/Layer";
import { LakeDatabaseRole, makeLakeDatabaseHttpBinding } from "./BindingHttp.ts";
import { GetSyMSOperationStatus } from "./GetSyMSOperationStatus.ts";

/**
 * Implementation of {@link GetSyMSOperationStatus} over the distilled
 * `synapse-data` data plane. Assigns the Synapse role **Synapse Artifact User**
 * on the workspace.
 *
 * @layer
 * @provides Azure.Synapse.GetSyMSOperationStatus
 */
export const GetSyMSOperationStatusHttp = Layer.effect(
  GetSyMSOperationStatus,
  makeLakeDatabaseHttpBinding({
    tag: "Azure.Synapse.GetSyMSOperationStatus",
    operation: syms.GetSyMSOperationStatus,
    grant: LakeDatabaseRole.Read,
  }),
);
