import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Factory } from "./Factory.ts";

export interface GetPipelineRunRequest extends Omit<
  datafactory.GetPipelineRunRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName"
> {}

/**
 * Read a pipeline run of a Data Factory by run ID (`GET
 * …/pipelineruns/{runId}`): its status, start and end time, and message.
 *
 * Binding assigns a custom role (`AzureDataFactoryGetPipelineRunRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/pipelineruns/read`, on the factory only. On
 * a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link GetPipelineRunHttp}.
 *
 * ### Calling GetPipelineRun
 * **Example:** GetPipelineRun from a Function
 * ```typescript
 * // init
 * const getPipelineRun = yield* Azure.DataFactory.GetPipelineRun(factory);
 *
 * // runtime
 * const run = yield* getPipelineRun({ runId });
 * if (run.status === "Succeeded") {
 *   // ...
 * }
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getPipelineRun = yield* Azure.DataFactory.GetPipelineRun(factory);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.GetPipelineRunHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface GetPipelineRun extends Binding.Service<
  GetPipelineRun,
  "Azure.DataFactory.GetPipelineRun",
  (
    factory: Factory,
  ) => Effect.Effect<
    (
      request: GetPipelineRunRequest,
    ) => Effect.Effect<datafactory.PipelineRun, datafactory.GetPipelineRunError, RuntimeContext>
  >
> {}

export const GetPipelineRun = Binding.Service<GetPipelineRun>("Azure.DataFactory.GetPipelineRun");
