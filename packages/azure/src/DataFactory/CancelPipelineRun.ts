import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Factory } from "./Factory.ts";

export interface CancelPipelineRunRequest extends Omit<
  datafactory.CancelPipelineRunRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName"
> {}

/**
 * Cancel a pipeline run of a Data Factory by run ID (`POST
 * …/pipelineruns/{runId}/cancel`).
 *
 * Binding assigns a custom role (`AzureDataFactoryCancelPipelineRunRole`, one
 * per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/pipelineruns/cancel/action`, on the factory
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelPipelineRunHttp}.
 *
 * ### Calling CancelPipelineRun
 * **Example:** CancelPipelineRun from a Function
 * ```typescript
 * // init
 * const cancelPipelineRun = yield* Azure.DataFactory.CancelPipelineRun(factory);
 *
 * // runtime
 * yield* cancelPipelineRun({ runId, isRecursive: true });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const cancelPipelineRun = yield* Azure.DataFactory.CancelPipelineRun(factory);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.CancelPipelineRunHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface CancelPipelineRun extends Binding.Service<
  CancelPipelineRun,
  "Azure.DataFactory.CancelPipelineRun",
  (
    factory: Factory,
  ) => Effect.Effect<
    (
      request: CancelPipelineRunRequest,
    ) => Effect.Effect<
      datafactory.CancelPipelineRunResponse,
      datafactory.CancelPipelineRunError,
      RuntimeContext
    >
  >
> {}

export const CancelPipelineRun = Binding.Service<CancelPipelineRun>(
  "Azure.DataFactory.CancelPipelineRun",
);
