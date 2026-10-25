import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MonitoredResource } from "../Monitor/MonitoredResource.ts";

export interface ExecuteQueryWithResourceIdRequest extends Omit<
  query.ExecuteQueryWithResourceIdRequest,
  "resourceId"
> {}

/**
 * Run a KQL query over the logs of one Azure resource (a resource-context
 * query, `POST /{resourceId}/query`) from any host: the query sees only the
 * rows that resource sent, in every workspace it sends to.
 *
 * Binding assigns a custom role (`AzureMonitorQueryResourceLogsRole`, one
 * per stack) with exactly the action `Microsoft.Insights/logs/<table>/read`
 * for every table (a wildcard), on the bound resource only. The workspace
 * must allow resource-context access (the default). On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container
 * App, container group, VM, or AKS workload identity) the role goes to
 * that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link ExecuteQueryWithResourceIdHttp}.
 *
 * ### Calling ExecuteQueryWithResourceId
 * **Example:** ExecuteQueryWithResourceId from a Function
 * ```typescript
 * // init
 * const queryLogs = yield* Azure.LogAnalytics.ExecuteQueryWithResourceId({
 *   resource: account,
 *   resourceId: account.storageAccountId,
 *   location: account.location,
 * });
 *
 * // runtime
 * const result = yield* queryLogs({ query: "AzureDiagnostics | take 10", timespan: "PT1H" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const queryLogs = yield* Azure.LogAnalytics.ExecuteQueryWithResourceId(target);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.ExecuteQueryWithResourceIdHttp));
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface ExecuteQueryWithResourceId extends Binding.Service<
  ExecuteQueryWithResourceId,
  "Azure.LogAnalytics.ExecuteQueryWithResourceId",
  (
    resource: MonitoredResource,
  ) => Effect.Effect<
    (
      request: ExecuteQueryWithResourceIdRequest,
    ) => Effect.Effect<query.QueryResults, query.ExecuteQueryWithResourceIdError, RuntimeContext>
  >
> {}

export const ExecuteQueryWithResourceId = Binding.Service<ExecuteQueryWithResourceId>(
  "Azure.LogAnalytics.ExecuteQueryWithResourceId",
);
