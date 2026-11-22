import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * Request of a {@link GetQuery} call. The bound workspace supplies
 * `workspaceId`.
 *
 * - `query`: the KQL query text, e.g. `"Heartbeat | count"`.
 * - `timespan` (optional): ISO 8601 duration or interval applied on top of
 *   any time filter in the query, e.g. `PT1H` or `P1D`. Default: no extra
 *   time filter.
 * - `endpoint` (optional): Log Analytics endpoint. Default:
 *   `https://api.loganalytics.io`.
 */
export interface GetQueryRequest extends Omit<query.GetQueryRequest, "workspaceId"> {}

/**
 * Run a KQL query against a Log Analytics workspace with a `GET /query` (the
 * query rides in the URL, so keep it short) from any host. Use {@link
 * ExecuteQuery} for long queries or extra workspaces.
 *
 * Binding assigns the built-in **Log Analytics Data Reader** (actions
 * `workspaces/read` and `workspaces/query/read`, data action
 * `workspaces/tables/data/read`: the smallest built-in role that runs
 * queries) on the workspace only. On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group, VM,
 * or AKS workload identity) the role goes to that identity; any other host
 * (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetQueryHttp}.
 *
 * ### Running a Short Query
 * **Example:** Count heartbeats from an Azure Function
 * ```typescript
 * const Logs = Azure.LogAnalytics.Workspace("Logs", {});
 *
 * export default class Reports extends Azure.Functions.Function<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workspace = yield* Logs;
 *     // init: assigns Log Analytics Data Reader on the workspace only
 *     const getQuery = yield* Azure.LogAnalytics.GetQuery(workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const result = yield* getQuery({ query: "Heartbeat | count", timespan: "P1D" });
 *         return yield* HttpServerResponse.json({ count: result.tables[0]?.rows[0]?.[0] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.LogAnalytics.GetQueryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface GetQuery extends Binding.Service<
  GetQuery,
  "Azure.LogAnalytics.GetQuery",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetQueryRequest,
    ) => Effect.Effect<query.QueryResults, query.GetQueryError, RuntimeContext>
  >
> {}

export const GetQuery = Binding.Service<GetQuery>("Azure.LogAnalytics.GetQuery");
