import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeWorkstationHttpBinding } from "./BindingHttp.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";

export interface StartWorkstationRequest extends Omit<
  workstations.StartProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Workstations `workstations.start`.
 *
 * Bind this operation to a
 * {@link WorkstationClustersWorkstationConfigsWorkstation} in a
 * Function/Action init phase. Provide {@link StartWorkstationHttp}.
 * Grants `roles/workstations.user` on the workstation only.
 *
 * ### Starting a Workstation
 * **Example:** Start the bound workstation
 * ```typescript
 * const start = yield* GCP.Workstations.StartWorkstation(dev);
 * yield* start();
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface StartWorkstation extends Binding.Service<
  StartWorkstation,
  "GCP.Workstations.StartWorkstation",
  (
    workstation: WorkstationClustersWorkstationConfigsWorkstation,
  ) => Effect.Effect<
    (
      request?: StartWorkstationRequest,
    ) => Effect.Effect<
      workstations.Operation,
      workstations.StartProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsError,
      RuntimeContext
    >
  >
> {}

export const StartWorkstation = Binding.Service<StartWorkstation>(
  "GCP.Workstations.StartWorkstation",
);

/**
 * HTTP implementation of {@link StartWorkstation}.
 *
 * @layer
 * @provides GCP.Workstations.StartWorkstation
 */
export const StartWorkstationHttp = Layer.effect(
  StartWorkstation,
  makeWorkstationHttpBinding({
    tag: "GCP.Workstations.StartWorkstation",
    iam: { role: "roles/workstations.user", on: "workstations.workstation" },
    operation: workstations.startProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
