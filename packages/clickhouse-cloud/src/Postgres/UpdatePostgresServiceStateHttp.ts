import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindPostgres } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { Service } from "./Service.ts";
import { UpdatePostgresServiceState } from "./UpdatePostgresServiceState.ts";

/** {@link UpdatePostgresServiceState} over the ClickHouse Cloud API; works on any host. */
export const UpdatePostgresServiceStateHttp = Layer.effect(
  UpdatePostgresServiceState,
  Effect.gen(function* () {
    const bind = yield* BindPostgres;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("UpdatePostgresServiceState", target, [
        "control-plane:postgres-service:view",
        "control-plane:postgres-service:manage",
      ]);
      return (command: "restart" | "promote" | "switchover") =>
        run((ids) =>
          postgres
            .updatePostgresServiceState({ ...ids, command })
            .pipe(Effect.flatMap(requireResult("updatePostgresServiceState"))),
        );
    });
  }),
);
