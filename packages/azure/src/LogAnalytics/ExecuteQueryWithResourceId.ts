import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MonitoredResource } from "../Monitor/MonitoredResource.ts";

/**
 * Request of an {@link ExecuteQueryWithResourceId} call. The bound resource
 * supplies `resourceId`.
 *
 * - `query`: the KQL query text, e.g. `"Heartbeat | count"`.
 * - `timespan` (optional): ISO 8601 duration or interval applied on top of
 *   any time filter in the query, e.g. `PT1H` or `P1D`. Default: no extra
 *   time filter.
 * - `workspaces` (optional): workspaces to limit the query to. Default:
 *   every workspace the resource sends logs to.
 * - `prefer` (optional): `Prefer` header, e.g. `wait=60` (server timeout in
 *   seconds) or `include-statistics=true`. Default: not sent.
 * - `endpoint` (optional): Log Analytics endpoint. Default:
 *   `https://api.loganalytics.io`.
 */
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
 * The resource must send its logs to a workspace (a diagnostic setting),
 * or the query returns no rows.
 * Provide {@link ExecuteQueryWithResourceIdHttp}.
 *
 * ### Querying One Resource's Logs
 * **Example:** Query a storage account's logs from an Azure Function
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Reports extends Azure.Functions.Function<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: assigns AzureMonitorQueryResourceLogsRole on the account only
 *     const queryLogs = yield* Azure.LogAnalytics.ExecuteQueryWithResourceId({
 *       resource: account,
 *       resourceId: account.storageAccountId,
 *       location: account.location,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const result = yield* queryLogs({
 *           query: "StorageBlobLogs | take 10",
 *           timespan: "PT1H",
 *         });
 *         return yield* HttpServerResponse.json({ rows: result.tables[0]?.rows ?? [] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.LogAnalytics.ExecuteQueryWithResourceIdHttp)),
 * ) {}
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
