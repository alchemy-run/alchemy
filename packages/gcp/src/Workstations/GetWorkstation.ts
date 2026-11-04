import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeWorkstationHttpBinding } from "./BindingHttp.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";

export interface GetWorkstationRequest extends Omit<
  workstations.GetProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Workstations `workstations.get`.
 *
 * Bind this operation to a
 * {@link WorkstationClustersWorkstationConfigsWorkstation} in a
 * Function/Action init phase. Provide {@link GetWorkstationHttp}.
 * Grants `roles/workstations.user` on the workstation only: the smallest
 * role a workstation accepts that reads it.
 *
 * ### Observing Workstations
 * **Example:** Read the bound workstation
 * ```typescript
 * const getWorkstation = yield* GCP.Workstations.GetWorkstation(dev);
 * const live = yield* getWorkstation();
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface GetWorkstation extends Binding.Service<
  GetWorkstation,
  "GCP.Workstations.GetWorkstation",
  (
    workstation: WorkstationClustersWorkstationConfigsWorkstation,
  ) => Effect.Effect<
    (
      request?: GetWorkstationRequest,
    ) => Effect.Effect<
      workstations.Workstation,
      workstations.GetProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsError,
      RuntimeContext
    >
  >
> {}

export const GetWorkstation = Binding.Service<GetWorkstation>("GCP.Workstations.GetWorkstation");

/**
 * HTTP implementation of {@link GetWorkstation}.
 *
 * @layer
 * @provides GCP.Workstations.GetWorkstation
 */
export const GetWorkstationHttp = Layer.effect(
  GetWorkstation,
  makeWorkstationHttpBinding({
    tag: "GCP.Workstations.GetWorkstation",
    iam: { role: "roles/workstations.user", on: "workstations.workstation" },
    operation: workstations.getProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
