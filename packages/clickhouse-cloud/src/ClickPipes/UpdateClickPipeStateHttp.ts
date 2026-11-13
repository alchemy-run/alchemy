import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { ClickPipe } from "./ClickPipe.ts";
import { UpdateClickPipeState } from "./UpdateClickPipeState.ts";

/** {@link UpdateClickPipeState} over the ClickHouse Cloud API; works on any host. */
export const UpdateClickPipeStateHttp = Layer.effect(
  UpdateClickPipeState,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: ClickPipe) {
      const run = yield* bind("UpdateClickPipeState", target, [
        "control-plane:service:view",
        "control-plane:service:manage-clickpipes",
        // ClickPipes answers "No database access to use ClickPipes" without it.
        "sql-console:database:access",
      ]);
      const clickPipeId = yield* target.clickPipeId;
      return (command: "start" | "stop" | "resync") =>
        run((ids) =>
          Effect.flatMap(clickPipeId, (id) =>
            pipes.updateClickPipeState({ ...ids, clickPipeId: id, command }),
          ),
        );
    });
  }),
);
