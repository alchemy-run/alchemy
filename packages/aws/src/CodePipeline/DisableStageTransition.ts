import type * as SVC from "@distilled.cloud/aws/codepipeline";
import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface DisableStageTransitionRequest extends Omit<
  SVC.DisableStageTransitionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:DisableStageTransition` — freezes a
 * transition into (`Inbound`) or out of (`Outbound`) a stage, e.g. to gate
 * deploys during an incident.
 * ### Operating Stages
 * **Example:** Freeze Deploys
 * ```typescript
 * const disableTransition =
 *   yield* AWS.CodePipeline.DisableStageTransition(pipeline);
 *
 * yield* disableTransition({
 *   stageName: "Deploy",
 *   transitionType: "Inbound",
 *   reason: "incident in progress",
 * });
 * ```
 *
 * @binding
 */
export interface DisableStageTransition extends Binding.Service<
  DisableStageTransition,
  "AWS.CodePipeline.DisableStageTransition",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: DisableStageTransitionRequest,
    ) => Effect.Effect<SVC.DisableStageTransitionResponse, SVC.DisableStageTransitionError>
  >
> {}
export const DisableStageTransition = Binding.Service<DisableStageTransition>(
  "AWS.CodePipeline.DisableStageTransition",
);

export const DisableStageTransitionHttp = Layer.effect(
  DisableStageTransition,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.DisableStageTransition",
    operation: codepipeline.disableStageTransition,
    actions: ["codepipeline:DisableStageTransition"],
    subScoped: true,
  }),
);
