import type * as insights from "@distilled.cloud/azure/monitor-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { MonitoredResource } from "./MonitoredResource.ts";

export interface GetMetricsBatchRequest extends Omit<
  insights.BatchRequest,
  "endpoint" | "subscriptionId" | "resourceids" | "metricnames"
> {
  /** Metric names to read, e.g. `["Transactions", "Ingress"]`. */
  metricnames: string[];
}

/**
 * Read platform metrics for one or more Azure resources in one call (the
 * Azure Monitor `metrics:getBatch` API) from any host. The resources must
 * share a subscription, a region, and the `metricnamespace` of the request
 * (at most 50 resources).
 *
 * Binding assigns the built-in **Monitoring Reader** on the subscription
 * the resources are in. The batch API is a subscription-level API and
 * rejects smaller grants: a custom role with exactly
 * `Microsoft.Insights/Metrics/Read` and
 * `Microsoft.Resources/subscriptions/resourceGroups/read` on the
 * subscription is answered `Forbidden` ("Please make sure grant 'Monitoring
 * Reader' role permission to the subscription"). Monitoring Reader reads
 * the control plane of every resource in the subscription, so
 * prefer a dedicated subscription for hosts that only need a few metrics.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMetricsBatchHttp}.
 *
 * ### Reading Metrics
 * **Example:** Read storage transactions from a Function
 * ```typescript
 * // init
 * const getMetrics = yield* Azure.Monitor.GetMetricsBatch({
 *   resource: account,
 *   resourceId: account.storageAccountId,
 *   location: account.location,
 * });
 *
 * // runtime
 * const result = yield* getMetrics({
 *   metricnamespace: "Microsoft.Storage/storageAccounts",
 *   metricnames: ["Transactions"],
 *   aggregation: "total",
 *   interval: "PT1H",
 * });
 * const series = result.values?.[0]?.value[0]?.timeseries;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getMetrics = yield* Azure.Monitor.GetMetricsBatch(target, other);
 *   // ...
 * }).pipe(Effect.provide(Azure.Monitor.GetMetricsBatchHttp));
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
