import * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import type { Organization } from "../Organization/Organization.ts";
import { GetOrganizationPrometheusDiscovery } from "./GetOrganizationPrometheusDiscovery.ts";
import type { PrometheusMetricsRequest } from "./GetServicePrometheusMetrics.ts";

/** {@link GetOrganizationPrometheusDiscovery} over the ClickHouse Cloud API; works on any host. */
export const GetOrganizationPrometheusDiscoveryHttp = Layer.effect(
  GetOrganizationPrometheusDiscovery,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("GetOrganizationPrometheusDiscovery", target, [
        "control-plane:organization:view",
      ]);
      return (request?: PrometheusMetricsRequest) =>
        run((ids) =>
          prometheus.getOrganizationPrometheusDiscovery({
            ...ids,
            ...(request?.filteredMetrics !== undefined
              ? { filtered_metrics: String(request.filteredMetrics) }
              : {}),
          }),
        );
    });
  }),
);
