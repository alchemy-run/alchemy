import * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { Service } from "../Service/Service.ts";
import {
  GetServicePrometheusMetrics,
  type PrometheusMetricsRequest,
} from "./GetServicePrometheusMetrics.ts";

/** {@link GetServicePrometheusMetrics} over the ClickHouse Cloud API; works on any host. */
export const GetServicePrometheusMetricsHttp = Layer.effect(
  GetServicePrometheusMetrics,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetServicePrometheusMetrics", target, [
        "control-plane:service:view",
      ]);
      return (request?: PrometheusMetricsRequest) =>
        run((ids) =>
          prometheus.getServicePrometheusMetrics({
            ...ids,
            ...(request?.filteredMetrics !== undefined
              ? { filtered_metrics: String(request.filteredMetrics) }
              : {}),
          }),
        );
    });
  }),
);
