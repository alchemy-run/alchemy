import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

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
 * ### Calling ExecuteQuery
 * **Example:** ExecuteQuery from a Function
 * ```typescript
 * // init
 * const executeQuery = yield* Azure.LogAnalytics.ExecuteQuery(workspace);
 *
 * // runtime
 * const result = yield* executeQuery({
 *   query: "AppEvents_CL | where Level == 'error' | take 10",
 *   timespan: "PT1H",
 * });
 * const rows = result.tables[0]?.rows ?? [];
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const executeQuery = yield* Azure.LogAnalytics.ExecuteQuery(workspace);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.ExecuteQueryHttp));
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
