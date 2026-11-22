import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * One query of a {@link QueryBatch} call. It runs as `POST /query` against
 * the bound workspace.
 *
 * - `id`: ID of the query, unique in the batch. Its answer carries the
 *   same `id`.
 * - `body`: the query: `{ query, timespan?, workspaces? }`, with the same
 *   meaning as in `ExecuteQueryRequest`.
 * - `headers` (optional): request headers, e.g.
 *   `{ Prefer: "include-statistics=true" }`. Default: none.
 */
export interface QueryBatchItem extends Omit<
  query.BatchQueryRequest,
  "workspace" | "path" | "method"
> {}

/**
 * Request of a {@link QueryBatch} call: the `requests`, plus an optional
 * `endpoint` (Log Analytics endpoint, default `https://api.loganalytics.io`).
 */
export interface QueryBatchRequest extends Omit<query.QueryBatchRequest, "requests"> {
  /** The queries, each with an `id` unique in the batch. Send at most 10. */
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
 * ### Running Several Queries
 * **Example:** Two queries in one call from an Azure Function
 * ```typescript
 * const Logs = Azure.LogAnalytics.Workspace("Logs", {});
 *
 * export default class Reports extends Azure.Functions.Function<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workspace = yield* Logs;
 *     // init: assigns Log Analytics Data Reader on the workspace only
 *     const queryBatch = yield* Azure.LogAnalytics.QueryBatch(workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const { responses } = yield* queryBatch({
 *           requests: [
 *             { id: "errors", body: { query: "AppEvents_CL | where Level == 'error' | count" } },
 *             { id: "total", body: { query: "AppEvents_CL | count", timespan: "P1D" } },
 *           ],
 *         });
 *         const errors = responses?.find((r) => r.id === "errors");
 *         return yield* HttpServerResponse.json({
 *           status: errors?.status,
 *           rows: errors?.body?.tables?.[0]?.rows ?? [],
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.LogAnalytics.QueryBatchHttp)),
 * ) {}
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
