import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { ListPostgresLogs, type ListPostgresLogsRequest } from "./ListPostgresLogs.ts";
import type { Service } from "./Service.ts";

/** {@link ListPostgresLogs} over the ClickHouse Cloud API; works on any host. */
export const ListPostgresLogsHttp = Layer.effect(
  ListPostgresLogs,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("ListPostgresLogs", target, ["control-plane:postgres-service:view"]);
      return (request: ListPostgresLogsRequest) =>
        run((ids) =>
          postgres.listPostgresLogs({
            ...ids,
            from_date: request.fromDate,
            to_date: request.toDate,
            body_contains: request.bodyContains,
            severity: request.severity,
            sort_order: request.sortOrder,
            limit: request.limit,
            offset: request.offset,
          }),
        );
    });
  }),
);
