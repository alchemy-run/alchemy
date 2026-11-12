import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import { GetPostgresService } from "./GetPostgresService.ts";
import type { Service } from "./Service.ts";

/** {@link GetPostgresService} over the ClickHouse Cloud API; works on any host. */
export const GetPostgresServiceHttp = Layer.effect(
  GetPostgresService,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetPostgresService", target, [
        "control-plane:postgres-service:view",
      ]);
      return () =>
        run((ids) =>
          postgres
            .getPostgresService(ids)
            .pipe(Effect.flatMap(requireResult("getPostgresService"))),
        );
    });
  }),
);
