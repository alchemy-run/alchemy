import type * as SVC from "@distilled.cloud/aws/codepipeline";
import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface ListActionExecutionsRequest extends Omit<
  SVC.ListActionExecutionsInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:ListActionExecutions` — enumerates the
 * action-level execution history of the pipeline, optionally filtered to a
 * single execution.
 * ### Observing Pipelines
 * **Example:** List Action Executions For One Run
 * ```typescript
 * const listActions = yield* AWS.CodePipeline.ListActionExecutions(pipeline);
 *
 * const { actionExecutionDetails } = yield* listActions({
 *   filter: { pipelineExecutionId: executionId },
 * });
 * ```
 *
 * @binding
 */
export interface ListActionExecutions extends Binding.Service<
  ListActionExecutions,
  "AWS.CodePipeline.ListActionExecutions",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request?: ListActionExecutionsRequest,
    ) => Effect.Effect<SVC.ListActionExecutionsOutput, SVC.ListActionExecutionsError>
  >
> {}
export const ListActionExecutions = Binding.Service<ListActionExecutions>(
  "AWS.CodePipeline.ListActionExecutions",
);

export const ListActionExecutionsHttp = Layer.effect(
  ListActionExecutions,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.ListActionExecutions",
    operation: codepipeline.listActionExecutions,
    actions: ["codepipeline:ListActionExecutions"],
  }),
);
