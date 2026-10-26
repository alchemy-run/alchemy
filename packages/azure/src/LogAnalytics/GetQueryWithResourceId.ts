import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MonitoredResource } from "../Monitor/MonitoredResource.ts";

/**
 * Request of a {@link GetQueryWithResourceId} call. The bound resource
 * supplies `resourceId`.
 *
 * - `query`: the KQL query text, e.g. `"Heartbeat | count"`.
 * - `timespan` (optional): ISO 8601 duration or interval applied on top of
 *   any time filter in the query, e.g. `PT1H` or `P1D`. Default: no extra
 *   time filter.
 * - `endpoint` (optional): Log Analytics endpoint. Default:
 *   `https://api.loganalytics.io`.
 */
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
 * The resource must send its logs to a workspace (a diagnostic setting),
 * or the query returns no rows.
 * Provide {@link GetQueryWithResourceIdHttp}.
 *
 * ### Querying One Resource's Logs
 * **Example:** Count a storage account's log rows from an Azure Function
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Reports extends Azure.Functions.Function<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: assigns AzureMonitorQueryResourceLogsRole on the account only
 *     const queryLogs = yield* Azure.LogAnalytics.GetQueryWithResourceId({
 *       resource: account,
 *       resourceId: account.storageAccountId,
 *       location: account.location,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const result = yield* queryLogs({ query: "StorageBlobLogs | count", timespan: "P1D" });
 *         return yield* HttpServerResponse.json({ count: result.tables[0]?.rows[0]?.[0] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.LogAnalytics.GetQueryWithResourceIdHttp)),
 * ) {}
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
