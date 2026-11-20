import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:DescribeStep` — reads one step of the bound cluster — status, config, and failure details.
 * ### Running Steps
 * **Example:** Poll a Step's State
 * ```typescript
 * const describeStep = yield* AWS.EMR.DescribeStep(cluster);
 *
 * const { Step } = yield* describeStep({ StepId: stepId });
 * // Step.Status.State: PENDING | RUNNING | COMPLETED | FAILED | …
 * ```
 *
 * @binding
 */
export interface DescribeStep extends Binding.Service<
  DescribeStep,
  "AWS.EMR.DescribeStep",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DescribeStepInput, "ClusterId">,
    ) => Effect.Effect<SVC.DescribeStepOutput, SVC.DescribeStepError>
  >
> {}
export const DescribeStep = Binding.Service<DescribeStep>("AWS.EMR.DescribeStep");

export const DescribeStepHttp = Layer.effect(
  DescribeStep,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.DescribeStep",
    operation: emr.describeStep,
    actions: ["elasticmapreduce:DescribeStep"],
  }),
);
