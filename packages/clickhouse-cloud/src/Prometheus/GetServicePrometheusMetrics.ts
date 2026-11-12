import type * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "../Service/Service.ts";

/** Options for a metrics scrape. */
export interface PrometheusMetricsRequest {
  /**
   * Return ClickHouse's filtered list of metrics rather than every metric.
   * @default true
   */
  filteredMetrics?: boolean;
}

/**
 * Scrape a ClickHouse Cloud service's metrics at runtime, in the
 * Prometheus text exposition format. Use it to relay metrics to a backend
 * that can't reach the Cloud API itself.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` on the bound service. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Scraping Metrics
 * **Example:** Proxy the service's metrics
 * ```typescript
 * export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 *
 * export default class Metrics extends Cloudflare.Worker<Metrics>()(
 *   "Metrics",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:service:view on the service
 *     const scrape = yield* ClickHouseCloud.Prometheus.GetServicePrometheusMetrics(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const text = yield* scrape({ filteredMetrics: true });
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Prometheus.GetServicePrometheusMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Prometheus
 */
export interface GetServicePrometheusMetrics extends Binding.Service<
  GetServicePrometheusMetrics,
  "ClickHouseCloud.Prometheus.GetServicePrometheusMetrics",
  (
    target: Service,
  ) => Effect.Effect<
    (
      request?: PrometheusMetricsRequest,
    ) => Effect.Effect<string, prometheus.GetServicePrometheusMetricsError, RuntimeContext>
  >
> {}

export const GetServicePrometheusMetrics = Binding.Service<GetServicePrometheusMetrics>(
  "ClickHouseCloud.Prometheus.GetServicePrometheusMetrics",
);
