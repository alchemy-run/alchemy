import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import {
  GetPostgresServiceMetrics,
  type GetPostgresServiceMetricsRequest,
} from "./GetPostgresServiceMetrics.ts";
import type { Service } from "./Service.ts";

/** {@link GetPostgresServiceMetrics} over the ClickHouse Cloud API; works on any host. */
export const GetPostgresServiceMetricsHttp = Layer.effect(
  GetPostgresServiceMetrics,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetPostgresServiceMetrics", target, [
        "control-plane:postgres-service:view",
      ]);
      return (request: GetPostgresServiceMetricsRequest) =>
        run((ids) =>
          postgres
            .getPostgresServiceMetrics({
              ...ids,
              from_date: request.fromDate,
              to_date: request.toDate,
              bucket_size_seconds: request.bucketSizeSeconds,
            })
            .pipe(Effect.flatMap(requireResult("getPostgresServiceMetrics"))),
        );
    });
  }),
);
