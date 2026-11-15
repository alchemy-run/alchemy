import type * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "../Organization/Organization.ts";
import type { PrometheusMetricsRequest } from "./GetServicePrometheusMetrics.ts";

/**
 * List the organization's services as Prometheus scrape targets at
 * runtime, in the HTTP service discovery (`http_sd`) format: one target
 * group per service the key may view, labelled with the service's ID,
 * name, region and cloud provider. Serve it to Prometheus as an
 * `http_sd_configs` endpoint so new services are scraped without config
 * changes.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` on the organization. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Discovering Targets
 * **Example:** Serve `http_sd` targets to Prometheus
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Discovery extends Cloudflare.Worker<Discovery>()(
 *   "Discovery",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view on the organization
 *     const discover = yield* ClickHouseCloud.Prometheus.GetOrganizationPrometheusDiscovery(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const targets = yield* discover();
 *         return yield* HttpServerResponse.json(targets);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Prometheus.GetOrganizationPrometheusDiscoveryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Prometheus
 */
export interface GetOrganizationPrometheusDiscovery extends Binding.Service<
  GetOrganizationPrometheusDiscovery,
  "ClickHouseCloud.Prometheus.GetOrganizationPrometheusDiscovery",
  (
    target: Organization,
  ) => Effect.Effect<
    (
      request?: PrometheusMetricsRequest,
    ) => Effect.Effect<
      prometheus.GetOrganizationPrometheusDiscoveryResponse,
      prometheus.GetOrganizationPrometheusDiscoveryError,
      RuntimeContext
    >
  >
> {}

export const GetOrganizationPrometheusDiscovery =
  Binding.Service<GetOrganizationPrometheusDiscovery>(
    "ClickHouseCloud.Prometheus.GetOrganizationPrometheusDiscovery",
  );
