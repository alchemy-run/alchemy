import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Factory } from "./Factory.ts";

export interface QueryPipelineRunsRequest extends Omit<
  datafactory.PipelineRunsQueryByFactoryRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName"
> {}

/**
 * Query the pipeline runs of a Data Factory updated in a time window (`POST
 * …/queryPipelineRuns`), with optional filters and ordering. Follow
 * `continuationToken` for the next page.
 *
 * Binding assigns a custom role (`AzureDataFactoryQueryPipelineRunsRole`, one
 * per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/querypipelineruns/read`, on the factory
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link QueryPipelineRunsHttp}.
 *
 * ### Calling QueryPipelineRuns
 * **Example:** QueryPipelineRuns from a Function
 * ```typescript
 * // init
 * const queryPipelineRuns = yield* Azure.DataFactory.QueryPipelineRuns(factory);
 *
 * // runtime
 * const { value } = yield* queryPipelineRuns({
 *   lastUpdatedAfter: "2026-10-24T00:00:00Z",
 *   lastUpdatedBefore: "2026-10-25T00:00:00Z",
 *   filters: [{ operand: "Status", operator: "Equals", values: ["Failed"] }],
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const queryPipelineRuns = yield* Azure.DataFactory.QueryPipelineRuns(factory);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.QueryPipelineRunsHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface QueryPipelineRuns extends Binding.Service<
  QueryPipelineRuns,
  "Azure.DataFactory.QueryPipelineRuns",
  (
    factory: Factory,
  ) => Effect.Effect<
    (
      request: QueryPipelineRunsRequest,
    ) => Effect.Effect<
      datafactory.PipelineRunsQueryResponse,
      datafactory.PipelineRunsQueryByFactoryError,
      RuntimeContext
    >
  >
> {}

export const QueryPipelineRuns = Binding.Service<QueryPipelineRuns>(
  "Azure.DataFactory.QueryPipelineRuns",
);
