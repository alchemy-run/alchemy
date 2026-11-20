import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeWorkstationHttpBinding } from "./BindingHttp.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";

export interface StopWorkstationRequest extends Omit<
  workstations.StopProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Workstations `workstations.stop`.
 *
 * Bind this operation to a
 * {@link WorkstationClustersWorkstationConfigsWorkstation} in a
 * Function/Action init phase. Provide {@link StopWorkstationHttp}.
 * Grants `roles/workstations.user` on the workstation only.
 *
 * ### Stopping a Workstation
 * **Example:** Stop the bound workstation
 * ```typescript
 * const stop = yield* GCP.Workstations.StopWorkstation(dev);
 * yield* stop();
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface StopWorkstation extends Binding.Service<
  StopWorkstation,
  "GCP.Workstations.StopWorkstation",
  (
    workstation: WorkstationClustersWorkstationConfigsWorkstation,
  ) => Effect.Effect<
    (
      request?: StopWorkstationRequest,
    ) => Effect.Effect<
      workstations.Operation,
      workstations.StopProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsError,
      RuntimeContext
    >
  >
> {}

export const StopWorkstation = Binding.Service<StopWorkstation>("GCP.Workstations.StopWorkstation");

/**
 * HTTP implementation of {@link StopWorkstation}.
 *
 * @layer
 * @provides GCP.Workstations.StopWorkstation
 */
export const StopWorkstationHttp = Layer.effect(
  StopWorkstation,
  makeWorkstationHttpBinding({
    tag: "GCP.Workstations.StopWorkstation",
    iam: { role: "roles/workstations.user", on: "workstations.workstation" },
    operation: workstations.stopProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
