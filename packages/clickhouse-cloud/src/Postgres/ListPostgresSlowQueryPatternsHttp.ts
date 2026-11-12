import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import {
  ListPostgresSlowQueryPatterns,
  type ListPostgresSlowQueryPatternsRequest,
} from "./ListPostgresSlowQueryPatterns.ts";
import type { Service } from "./Service.ts";

/** {@link ListPostgresSlowQueryPatterns} over the ClickHouse Cloud API; works on any host. */
export const ListPostgresSlowQueryPatternsHttp = Layer.effect(
  ListPostgresSlowQueryPatterns,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("ListPostgresSlowQueryPatterns", target, [
        "control-plane:postgres-service:view",
      ]);
      return (request: ListPostgresSlowQueryPatternsRequest) =>
        run((ids) =>
          postgres
            .listPostgresSlowQueryPatterns({
              ...ids,
              from_date: request.fromDate,
              to_date: request.toDate,
              db_name: request.dbName,
              db_user: request.dbUser,
              db_operation: request.dbOperation,
              app: request.app,
              sort_by: request.sortBy,
              sort_order: request.sortOrder,
              limit: request.limit,
              offset: request.offset,
            })
            .pipe(Effect.flatMap(requireResult("listPostgresSlowQueryPatterns"))),
        );
    });
  }),
);
