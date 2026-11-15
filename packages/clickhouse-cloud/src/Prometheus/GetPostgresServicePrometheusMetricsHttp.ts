import * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import type { Service as PostgresService } from "../Postgres/Service.ts";
import { GetPostgresServicePrometheusMetrics } from "./GetPostgresServicePrometheusMetrics.ts";

/** {@link GetPostgresServicePrometheusMetrics} over the ClickHouse Cloud API; works on any host. */
export const GetPostgresServicePrometheusMetricsHttp = Layer.effect(
  GetPostgresServicePrometheusMetrics,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: PostgresService) {
      const run = yield* bind("GetPostgresServicePrometheusMetrics", target, [
        "control-plane:postgres-service:view",
      ]);
      return () => run((ids) => prometheus.getPostgresServicePrometheusMetrics(ids));
    });
  }),
);
