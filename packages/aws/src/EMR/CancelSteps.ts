import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:CancelSteps` — cancels pending or running steps on the bound cluster. Cancellation is asynchronous — poll {@link DescribeStep} for the final state.
 * ### Running Steps
 * **Example:** Cancel a Step
 * ```typescript
 * const cancelSteps = yield* AWS.EMR.CancelSteps(cluster);
 *
 * const { CancelStepsInfoList } = yield* cancelSteps({
 *   StepIds: [stepId],
 *   StepCancellationOption: "SEND_INTERRUPT",
 * });
 * ```
 *
 * @binding
 */
export interface CancelSteps extends Binding.Service<
  CancelSteps,
  "AWS.EMR.CancelSteps",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.CancelStepsInput, "ClusterId">,
    ) => Effect.Effect<SVC.CancelStepsOutput, SVC.CancelStepsError>
  >
> {}
export const CancelSteps = Binding.Service<CancelSteps>("AWS.EMR.CancelSteps");

export const CancelStepsHttp = Layer.effect(
  CancelSteps,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.CancelSteps",
    operation: emr.cancelSteps,
    actions: ["elasticmapreduce:CancelSteps"],
  }),
);
