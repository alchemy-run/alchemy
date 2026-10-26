import type * as insights from "@distilled.cloud/azure/monitor-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MonitoredResource } from "./MonitoredResource.ts";

/**
 * The `metrics:getBatch` request without the `endpoint`, `subscriptionId`,
 * and `resourceids` the bound resources supply. `metricnamespace` is the
 * resource type, e.g. `Microsoft.Storage/storageAccounts`. Optional:
 * `interval` (ISO 8601 time grain, default `PT1M`, or `FULL`), `aggregation`
 * (e.g. `total`, `average`), `starttime`/`endtime` (default the last hour),
 * `filter`, `top`, `orderby`, and `rollupby`.
 */
export interface GetMetricsBatchRequest extends Omit<
  insights.BatchRequest,
  "endpoint" | "subscriptionId" | "resourceids" | "metricnames"
> {
  /** Metric names to read, e.g. `["Transactions", "Ingress"]`. */
  metricnames: string[];
}

/**
 * Read platform metrics for one or more Azure resources in one call (the
 * Azure Monitor `metrics:getBatch` API) from any host. Bind each resource
 * as a {@link MonitoredResource} (`resource`, `resourceId`, `location`).
 * The resources must share a subscription, a region, and the
 * `metricnamespace` of the request (at most 50 resources).
 *
 * Binding assigns the built-in **Monitoring Reader** on the subscription
 * the resources are in. The batch API is a subscription-level API and
 * rejects smaller grants: a custom role with exactly
 * `Microsoft.Insights/Metrics/Read` and
 * `Microsoft.Resources/subscriptions/resourceGroups/read` on the
 * subscription is answered `Forbidden` ("Please make sure grant 'Monitoring
 * Reader' role permission to the subscription").
 *
 * :::caution
 * Monitoring Reader reads the control plane of every resource in the
 * subscription, not only the bound resources. Use a dedicated subscription
 * for hosts that only need a few metrics.
 * :::
 *
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetMetricsBatchHttp}.
 *
 * ### Reading Metrics
 * **Example:** Read hourly storage transactions from a Function
 * ```typescript
 * const Data = Azure.Storage.StorageAccount("Data");
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: assigns Monitoring Reader on the account's subscription
 *     const getMetrics = yield* Azure.Monitor.GetMetricsBatch({
 *       resource: account,
 *       resourceId: account.storageAccountId,
 *       location: account.location,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const result = yield* getMetrics({
 *           metricnamespace: "Microsoft.Storage/storageAccounts",
 *           metricnames: ["Transactions", "Ingress"],
 *           aggregation: "total",
 *           interval: "PT1H",
 *         });
 *         return yield* HttpServerResponse.json(
 *           (result.values ?? []).map((value) => ({
 *             resourceId: value.resourceid,
 *             metrics: value.value.map((metric) => metric.name.value),
 *           })),
 *         );
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Monitor.GetMetricsBatchHttp)),
 * ) {}
 * ```
 *
 * ### Several Resources
 * **Example:** Read one metric for two storage accounts in one call
 * ```typescript
 * const Hot = Azure.Storage.StorageAccount("Hot");
 * const Cold = Azure.Storage.StorageAccount("Cold");
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const hot = yield* Hot;
 *     const cold = yield* Cold;
 *     const getMetrics = yield* Azure.Monitor.GetMetricsBatch(
 *       { resource: hot, resourceId: hot.storageAccountId, location: hot.location },
 *       { resource: cold, resourceId: cold.storageAccountId, location: cold.location },
 *     );
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getMetrics({
 *           metricnamespace: "Microsoft.Storage/storageAccounts",
 *           metricnames: ["UsedCapacity"],
 *           aggregation: "average",
 *           interval: "PT1H",
 *         });
 *         return yield* HttpServerResponse.json(result.values ?? []);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Monitor.GetMetricsBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Monitor
 */
export interface GetMetricsBatch extends Binding.Service<
  GetMetricsBatch,
  "Azure.Monitor.GetMetricsBatch",
  (
    ...resources: [MonitoredResource, ...MonitoredResource[]]
  ) => Effect.Effect<
    (
      request: GetMetricsBatchRequest,
    ) => Effect.Effect<insights.MetricResultsResponse, insights.BatchError, RuntimeContext>
  >
> {}

export const GetMetricsBatch = Binding.Service<GetMetricsBatch>("Azure.Monitor.GetMetricsBatch");
