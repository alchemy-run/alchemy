import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makePipelineHttpBinding } from "./BindingHttp.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface RunPipelineRequest extends Omit<
  datapipelines.RunProjectsLocationsPipelinesRequest,
  "name"
> {}

/**
 * Runtime binding for Data Pipelines `pipelines.run`.
 *
 * Creates a job for the bound pipeline immediately. Use this when the
 * internal scheduler is not configured. Bind in a Function/Action init
 * phase and provide {@link RunPipelineHttp}.
 *
 * ### Running Pipelines
 * **Example:** Run the bound pipeline now
 * ```typescript
 * const runPipeline = yield* GCP.DataPipelines.RunPipeline(batch);
 * const response = yield* runPipeline();
 * ```
 *
 * @binding
 * @category DataPipelines
 */
export interface RunPipeline extends Binding.Service<
  RunPipeline,
  "GCP.DataPipelines.RunPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    (
      request?: RunPipelineRequest,
    ) => Effect.Effect<
      datapipelines.GoogleCloudDatapipelinesV1RunPipelineResponse,
      datapipelines.RunProjectsLocationsPipelinesError,
      RuntimeContext
    >
  >
> {}

export const RunPipeline = Binding.Service<RunPipeline>("GCP.DataPipelines.RunPipeline");

/**
 * HTTP implementation of {@link RunPipeline}.
 *
 * @layer
 * @provides GCP.DataPipelines.RunPipeline
 */
export const RunPipelineHttp: Layer.Layer<RunPipeline, never, Credentials | HttpClient.HttpClient> =
  Layer.effect(
    RunPipeline,
    makePipelineHttpBinding<
      datapipelines.RunProjectsLocationsPipelinesRequest,
      datapipelines.GoogleCloudDatapipelinesV1RunPipelineResponse,
      datapipelines.RunProjectsLocationsPipelinesError
    >({
      tag: "GCP.DataPipelines.RunPipeline",
      iam: { role: "roles/datapipelines.invoker" },
      operation: datapipelines.runProjectsLocationsPipelines,
    }),
  );
