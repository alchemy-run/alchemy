import type * as SVC from "@distilled.cloud/aws/codepipeline";
import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface RollbackStageRequest extends Omit<SVC.RollbackStageInput, "pipelineName"> {}

/**
 * Runtime binding for `codepipeline:RollbackStage` — rolls a stage back to
 * the state of a previous successful execution (V2 pipelines).
 * ### Operating Stages
 * **Example:** Roll a Stage Back
 * ```typescript
 * const rollbackStage = yield* AWS.CodePipeline.RollbackStage(pipeline);
 *
 * yield* rollbackStage({
 *   stageName: "Deploy",
 *   targetPipelineExecutionId: lastGoodExecutionId,
 * });
 * ```
 *
 * @binding
 */
export interface RollbackStage extends Binding.Service<
  RollbackStage,
  "AWS.CodePipeline.RollbackStage",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: RollbackStageRequest,
    ) => Effect.Effect<SVC.RollbackStageOutput, SVC.RollbackStageError>
  >
> {}
export const RollbackStage = Binding.Service<RollbackStage>("AWS.CodePipeline.RollbackStage");

export const RollbackStageHttp = Layer.effect(
  RollbackStage,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.RollbackStage",
    operation: codepipeline.rollbackStage,
    actions: ["codepipeline:RollbackStage"],
    subScoped: true,
  }),
);
