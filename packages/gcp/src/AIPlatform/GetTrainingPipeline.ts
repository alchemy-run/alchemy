import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import type { TrainingPipeline } from "./TrainingPipeline.ts";

export interface GetTrainingPipelineRequest extends Omit<
  aiplatform.GetProjectsLocationsTrainingPipelinesRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `trainingPipelines.get`.
 *
 * Bind this operation to a {@link TrainingPipeline} in a Function/Action
 * init phase. Provide {@link GetTrainingPipelineHttp}.
 *
 * ### Observing Pipelines
 * **Example:** Read the bound pipeline
 * ```typescript
 * const getPipeline = yield* GCP.AIPlatform.GetTrainingPipeline(pipeline);
 * const live = yield* getPipeline();
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface GetTrainingPipeline extends Binding.Service<
  GetTrainingPipeline,
  "GCP.AIPlatform.GetTrainingPipeline",
  (
    pipeline: TrainingPipeline,
  ) => Effect.Effect<
    (
      request?: GetTrainingPipelineRequest,
    ) => Effect.Effect<
      aiplatform.GoogleCloudAiplatformV1TrainingPipeline,
      aiplatform.GetProjectsLocationsTrainingPipelinesError,
      RuntimeContext
    >
  >
> {}

export const GetTrainingPipeline = Binding.Service<GetTrainingPipeline>(
  "GCP.AIPlatform.GetTrainingPipeline",
);

/**
 * HTTP implementation of {@link GetTrainingPipeline}.
 *
 * @layer
 * @provides GCP.AIPlatform.GetTrainingPipeline
 */
export const GetTrainingPipelineHttp = Layer.effect(
  GetTrainingPipeline,
  makeNamedHttpBinding<
    TrainingPipeline,
    aiplatform.GetProjectsLocationsTrainingPipelinesRequest,
    aiplatform.GoogleCloudAiplatformV1TrainingPipeline,
    aiplatform.GetProjectsLocationsTrainingPipelinesError
  >({
    tag: "GCP.AIPlatform.GetTrainingPipeline",
    operation: aiplatform.getProjectsLocationsTrainingPipelines,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
