import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ModifyInstanceFleet` — retargets the bound cluster's instance fleet (on-demand/spot capacities, resize specifications).
 * ### Scaling the Cluster
 * **Example:** Retarget a Fleet
 * ```typescript
 * const modifyFleet = yield* AWS.EMR.ModifyInstanceFleet(cluster);
 *
 * yield* modifyFleet({
 *   InstanceFleet: {
 *     InstanceFleetId: fleetId,
 *     TargetOnDemandCapacity: 4,
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface ModifyInstanceFleet extends Binding.Service<
  ModifyInstanceFleet,
  "AWS.EMR.ModifyInstanceFleet",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ModifyInstanceFleetInput, "ClusterId">,
    ) => Effect.Effect<SVC.ModifyInstanceFleetResponse, SVC.ModifyInstanceFleetError>
  >
> {}
export const ModifyInstanceFleet = Binding.Service<ModifyInstanceFleet>(
  "AWS.EMR.ModifyInstanceFleet",
);

export const ModifyInstanceFleetHttp = Layer.effect(
  ModifyInstanceFleet,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ModifyInstanceFleet",
    operation: emr.modifyInstanceFleet,
    actions: ["elasticmapreduce:ModifyInstanceFleet"],
  }),
);
