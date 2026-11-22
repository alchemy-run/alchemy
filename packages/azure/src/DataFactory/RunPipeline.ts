import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Pipeline } from "./Pipeline.ts";

export interface RunPipelineRequest extends Omit<
  datafactory.CreatePipelineRunRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "pipelineName"
> {}

/**
 * Start a run of a Data Factory pipeline (`POST
 * …/pipelines/{pipeline}/createRun`) and get its run ID.
 *
 * Binding assigns a custom role (`AzureDataFactoryRunPipelineRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/pipelines/createrun/action`, on the
 * pipeline only. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link RunPipelineHttp}.
 *
 * ### Calling RunPipeline
 * **Example:** RunPipeline from a Function
 * ```typescript
 * // init
 * const runPipeline = yield* Azure.DataFactory.RunPipeline(pipeline);
 *
 * // runtime
 * const { runId } = yield* runPipeline({ body: { inputPath: "raw/2026-10-25" } });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const runPipeline = yield* Azure.DataFactory.RunPipeline(pipeline);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.RunPipelineHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface RunPipeline extends Binding.Service<
  RunPipeline,
  "Azure.DataFactory.RunPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    (
      request?: RunPipelineRequest,
    ) => Effect.Effect<
      datafactory.CreateRunResponse,
      datafactory.CreatePipelineRunError,
      RuntimeContext
    >
  >
> {}

export const RunPipeline = Binding.Service<RunPipeline>("Azure.DataFactory.RunPipeline");
