import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MonitoredResource } from "../Monitor/MonitoredResource.ts";

export interface GetQueryWithResourceIdRequest extends Omit<
  query.GetQueryWithResourceIdRequest,
  "resourceId"
> {}

/**
 * Run a resource-context KQL query with a `GET /{resourceId}/query` (the
 * query rides in the URL, so keep it short) from any host. Use {@link
 * ExecuteQueryWithResourceId} for long queries.
 *
 * Binding assigns a custom role (`AzureMonitorQueryResourceLogsRole`, one
 * per stack) with exactly the action `Microsoft.Insights/logs/<table>/read`
 * for every table (a wildcard), on the bound resource only. The workspace
 * must allow resource-context access (the default). On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container
 * App, container group, VM, or AKS workload identity) the role goes to
 * that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link GetQueryWithResourceIdHttp}.
 *
 * ### Calling GetQueryWithResourceId
 * **Example:** GetQueryWithResourceId from a Function
 * ```typescript
 * // init
 * const queryLogs = yield* Azure.LogAnalytics.GetQueryWithResourceId({
 *   resource: account,
 *   resourceId: account.storageAccountId,
 *   location: account.location,
 * });
 *
 * // runtime
 * const result = yield* queryLogs({ query: "AzureMetrics | count", timespan: "P1D" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const queryLogs = yield* Azure.LogAnalytics.GetQueryWithResourceId(target);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.GetQueryWithResourceIdHttp));
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface GetQueryWithResourceId extends Binding.Service<
  GetQueryWithResourceId,
  "Azure.LogAnalytics.GetQueryWithResourceId",
  (
    resource: MonitoredResource,
  ) => Effect.Effect<
    (
      request: GetQueryWithResourceIdRequest,
    ) => Effect.Effect<query.QueryResults, query.GetQueryWithResourceIdError, RuntimeContext>
  >
> {}

export const GetQueryWithResourceId = Binding.Service<GetQueryWithResourceId>(
  "Azure.LogAnalytics.GetQueryWithResourceId",
);
