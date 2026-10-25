import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/** One query of a batch; it runs against the bound workspace. */
export interface QueryBatchItem extends Omit<
  query.BatchQueryRequest,
  "workspace" | "path" | "method"
> {}

export interface QueryBatchRequest extends Omit<query.QueryBatchRequest, "requests"> {
  /** The queries, each with an `id` unique in the batch (at most 10). */
  requests: QueryBatchItem[];
}

/**
 * Run several KQL queries against a Log Analytics workspace in one call
 * (`POST /$batch`) from any host. Each answer carries the `id` of its
 * query and its own HTTP status, so one failing query does not fail the
 * batch.
 *
 * Binding assigns the built-in **Log Analytics Data Reader** (actions
 * `workspaces/read` and `workspaces/query/read`, data action
 * `workspaces/tables/data/read`: the smallest built-in role that runs
 * queries) on the workspace only. On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group, VM,
 * or AKS workload identity) the role goes to that identity; any other host
 * (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`). Provide {@link QueryBatchHttp}.
 *
 * ### Calling QueryBatch
 * **Example:** Two queries in one call
 * ```typescript
 * // init
 * const queryBatch = yield* Azure.LogAnalytics.QueryBatch(workspace);
 *
 * // runtime
 * const { responses } = yield* queryBatch({
 *   requests: [
 *     { id: "errors", body: { query: "AppEvents_CL | where Level == 'error' | count" } },
 *     { id: "total", body: { query: "AppEvents_CL | count", timespan: "P1D" } },
 *   ],
 * });
 * const errors = responses?.find((r) => r.id === "errors")?.body?.tables?.[0]?.rows;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const queryBatch = yield* Azure.LogAnalytics.QueryBatch(workspace);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.QueryBatchHttp));
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface QueryBatch extends Binding.Service<
  QueryBatch,
  "Azure.LogAnalytics.QueryBatch",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: QueryBatchRequest,
    ) => Effect.Effect<query.BatchResponse, query.QueryBatchError, RuntimeContext>
  >
> {}

export const QueryBatch = Binding.Service<QueryBatch>("Azure.LogAnalytics.QueryBatch");
