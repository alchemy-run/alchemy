import * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import type { Organization } from "../Organization/Organization.ts";
import { GetOrganizationPostgresPrometheusMetrics } from "./GetOrganizationPostgresPrometheusMetrics.ts";

/** {@link GetOrganizationPostgresPrometheusMetrics} over the ClickHouse Cloud API; works on any host. */
export const GetOrganizationPostgresPrometheusMetricsHttp = Layer.effect(
  GetOrganizationPostgresPrometheusMetrics,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("GetOrganizationPostgresPrometheusMetrics", target, [
        "control-plane:organization:view",
      ]);
      return () => run((ids) => prometheus.getOrganizationPostgresPrometheusMetrics(ids));
    });
  }),
);
