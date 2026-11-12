import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { ListPostgresServiceBackups } from "./ListPostgresServiceBackups.ts";
import type { Service } from "./Service.ts";

/** {@link ListPostgresServiceBackups} over the ClickHouse Cloud API; works on any host. */
export const ListPostgresServiceBackupsHttp = Layer.effect(
  ListPostgresServiceBackups,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("ListPostgresServiceBackups", target, [
        "control-plane:postgres-service:view",
      ]);
      return () =>
        run((ids) =>
          postgres.listPostgresServiceBackups.items(ids).pipe(
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        );
    });
  }),
);
