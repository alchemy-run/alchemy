import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

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
 * ### Calling GetQuery
 * **Example:** GetQuery from a Function
 * ```typescript
 * // init
 * const getQuery = yield* Azure.LogAnalytics.GetQuery(workspace);
 *
 * // runtime
 * const result = yield* getQuery({ query: "Heartbeat | count", timespan: "P1D" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getQuery = yield* Azure.LogAnalytics.GetQuery(workspace);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.GetQueryHttp));
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
