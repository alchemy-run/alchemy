import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import {
  GetPostgresSlowQueryPattern,
  type GetPostgresSlowQueryPatternRequest,
} from "./GetPostgresSlowQueryPattern.ts";
import type { Service } from "./Service.ts";

/** {@link GetPostgresSlowQueryPattern} over the ClickHouse Cloud API; works on any host. */
export const GetPostgresSlowQueryPatternHttp = Layer.effect(
  GetPostgresSlowQueryPattern,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetPostgresSlowQueryPattern", target, [
        "control-plane:postgres-service:view",
      ]);
      return (request: GetPostgresSlowQueryPatternRequest) =>
        run((ids) =>
          postgres
            .getPostgresSlowQueryPattern({
              ...ids,
              queryId: request.queryId,
              db_name: request.dbName,
              db_user: request.dbUser,
              db_operation: request.dbOperation,
              app: request.app,
              timestamp: request.timestamp,
            })
            .pipe(Effect.flatMap(requireResult("getPostgresSlowQueryPattern"))),
        );
    });
  }),
);
