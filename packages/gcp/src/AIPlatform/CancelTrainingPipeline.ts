import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import type { TrainingPipeline } from "./TrainingPipeline.ts";

export interface CancelTrainingPipelineRequest extends Omit<
  aiplatform.CancelProjectsLocationsTrainingPipelinesRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `trainingPipelines.cancel`.
 *
 * Bind this operation to a {@link TrainingPipeline} in a Function/Action
 * init phase. Provide {@link CancelTrainingPipelineHttp}.
 *
 * ### Cancelling
 * **Example:** Cancel the bound pipeline
 * ```typescript
 * const cancel = yield* GCP.AIPlatform.CancelTrainingPipeline(pipeline);
 * yield* cancel({ body: {} });
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface CancelTrainingPipeline extends Binding.Service<
  CancelTrainingPipeline,
  "GCP.AIPlatform.CancelTrainingPipeline",
  (
    pipeline: TrainingPipeline,
  ) => Effect.Effect<
    (
      request?: CancelTrainingPipelineRequest,
    ) => Effect.Effect<
      aiplatform.GoogleProtobufEmpty,
      aiplatform.CancelProjectsLocationsTrainingPipelinesError,
      RuntimeContext
    >
  >
> {}

export const CancelTrainingPipeline = Binding.Service<CancelTrainingPipeline>(
  "GCP.AIPlatform.CancelTrainingPipeline",
);

/**
 * HTTP implementation of {@link CancelTrainingPipeline}.
 *
 * @layer
 * @provides GCP.AIPlatform.CancelTrainingPipeline
 */
export const CancelTrainingPipelineHttp = Layer.effect(
  CancelTrainingPipeline,
  makeNamedHttpBinding<
    TrainingPipeline,
    aiplatform.CancelProjectsLocationsTrainingPipelinesRequest,
    aiplatform.GoogleProtobufEmpty,
    aiplatform.CancelProjectsLocationsTrainingPipelinesError
  >({
    tag: "GCP.AIPlatform.CancelTrainingPipeline",
    operation: aiplatform.cancelProjectsLocationsTrainingPipelines,
    iam: { role: "roles/aiplatform.user" },
  }),
);
