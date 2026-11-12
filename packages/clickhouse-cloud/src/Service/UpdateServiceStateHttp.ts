import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { Service } from "./Service.ts";
import { type ServiceStateCommand, UpdateServiceState } from "./UpdateServiceState.ts";

/** {@link UpdateServiceState} over the ClickHouse Cloud API; works on any host. */
export const UpdateServiceStateHttp = Layer.effect(
  UpdateServiceState,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("UpdateServiceState", target, [
        "control-plane:service:view",
        "control-plane:service:manage",
      ]);
      return (command: ServiceStateCommand) =>
        run((ids) =>
          service
            .updateServiceState({ ...ids, command })
            .pipe(Effect.flatMap(requireResult("updateServiceState"))),
        );
    });
  }),
);
