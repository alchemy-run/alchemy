import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `imagebuilder:ListWorkflowStepExecutions`.
 *
 * Lists the steps of one workflow execution with their runtime status —
 * drill-down from `ListWorkflowExecutions`. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListWorkflowStepExecutionsHttp)`.
 * ### Workflow Monitoring
 * **Example:** List the Steps of a Workflow Execution
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listWorkflowStepExecutions =
 *   yield* AWS.ImageBuilder.ListWorkflowStepExecutions();
 *
 * // runtime
 * const { steps } = yield* listWorkflowStepExecutions({
 *   workflowExecutionId,
 * });
 * ```
 *
 * @binding
 */
export interface ListWorkflowStepExecutions extends Binding.Service<
  ListWorkflowStepExecutions,
  "AWS.ImageBuilder.ListWorkflowStepExecutions",
  () => Effect.Effect<
    (
      request: imagebuilder.ListWorkflowStepExecutionsRequest,
    ) => Effect.Effect<
      imagebuilder.ListWorkflowStepExecutionsResponse,
      imagebuilder.ListWorkflowStepExecutionsError
    >
  >
> {}
export const ListWorkflowStepExecutions = Binding.Service<ListWorkflowStepExecutions>(
  "AWS.ImageBuilder.ListWorkflowStepExecutions",
);

export const ListWorkflowStepExecutionsHttp = Layer.effect(
  ListWorkflowStepExecutions,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListWorkflowStepExecutions",
    operation: imagebuilder.listWorkflowStepExecutions,
    actions: ["imagebuilder:ListWorkflowStepExecutions"],
  }),
);
