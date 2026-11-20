import type * as SVC from "@distilled.cloud/aws/codepipeline";
import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface ListPipelineExecutionsRequest extends Omit<
  SVC.ListPipelineExecutionsInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:ListPipelineExecutions` — enumerates
 * recent executions of the pipeline (newest first).
 * ### Observing Pipelines
 * **Example:** List Recent Executions
 * ```typescript
 * const listExecutions = yield* AWS.CodePipeline.ListPipelineExecutions(pipeline);
 *
 * const { pipelineExecutionSummaries } = yield* listExecutions({
 *   maxResults: 10,
 * });
 * ```
 *
 * @binding
 */
export interface ListPipelineExecutions extends Binding.Service<
  ListPipelineExecutions,
  "AWS.CodePipeline.ListPipelineExecutions",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request?: ListPipelineExecutionsRequest,
    ) => Effect.Effect<SVC.ListPipelineExecutionsOutput, SVC.ListPipelineExecutionsError>
  >
> {}
export const ListPipelineExecutions = Binding.Service<ListPipelineExecutions>(
  "AWS.CodePipeline.ListPipelineExecutions",
);

export const ListPipelineExecutionsHttp = Layer.effect(
  ListPipelineExecutions,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.ListPipelineExecutions",
    operation: codepipeline.listPipelineExecutions,
    actions: ["codepipeline:ListPipelineExecutions"],
  }),
);
