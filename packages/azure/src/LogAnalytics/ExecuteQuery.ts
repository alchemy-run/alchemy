import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * Request of an {@link ExecuteQuery} call. The bound workspace supplies
 * `workspaceId`.
 *
 * - `query`: the KQL query text, e.g. `"Heartbeat | count"`.
 * - `timespan` (optional): ISO 8601 duration or interval applied on top of
 *   any time filter in the query, e.g. `PT1H` or `P1D`. Default: no extra
 *   time filter.
 * - `workspaces` (optional): more workspaces to query with the primary one
 *   (names, customer IDs, or ARM IDs). The binding grants access to the
 *   bound workspace only. Default: only the bound workspace.
 * - `prefer` (optional): `Prefer` header, e.g. `wait=60` (server timeout in
 *   seconds) or `include-statistics=true`. Default: not sent.
 * - `endpoint` (optional): Log Analytics endpoint. Default:
 *   `https://api.loganalytics.io`.
 */
export interface ExecuteQueryRequest extends Omit<query.ExecuteQueryRequest, "workspaceId"> {}

/**
 * Run a KQL query against a Log Analytics workspace (`POST /query`) from any
 * host.
 *
 * Binding assigns the built-in **Log Analytics Data Reader** (actions
 * `workspaces/read` and `workspaces/query/read`, data action
 * `workspaces/tables/data/read`: the smallest built-in role that runs
 * queries) on the workspace only. On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group, VM,
 * or AKS workload identity) the role goes to that identity; any other host
 * (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ExecuteQueryHttp}.
 *
 * ### Running a Query
 * **Example:** Run a KQL query from an Azure Function
 * ```typescript
 * const Logs = Azure.LogAnalytics.Workspace("Logs", {});
 *
 * export default class Reports extends Azure.Functions.Function<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workspace = yield* Logs;
 *     // init: assigns Log Analytics Data Reader on the workspace only
 *     const executeQuery = yield* Azure.LogAnalytics.ExecuteQuery(workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const result = yield* executeQuery({
 *           query: "AppEvents_CL | where Level == 'error' | take 10",
 *           timespan: "PT1H",
 *         });
 *         return yield* HttpServerResponse.json({ rows: result.tables[0]?.rows ?? [] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.LogAnalytics.ExecuteQueryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface ExecuteQuery extends Binding.Service<
  ExecuteQuery,
  "Azure.LogAnalytics.ExecuteQuery",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ExecuteQueryRequest,
    ) => Effect.Effect<query.QueryResults, query.ExecuteQueryError, RuntimeContext>
  >
> {}

export const ExecuteQuery = Binding.Service<ExecuteQuery>("Azure.LogAnalytics.ExecuteQuery");
