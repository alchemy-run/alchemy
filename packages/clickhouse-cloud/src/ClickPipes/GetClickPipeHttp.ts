import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { ClickPipe } from "./ClickPipe.ts";
import { GetClickPipe } from "./GetClickPipe.ts";

/** {@link GetClickPipe} over the ClickHouse Cloud API; works on any host. */
export const GetClickPipeHttp = Layer.effect(
  GetClickPipe,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: ClickPipe) {
      const run = yield* bind("GetClickPipe", target, [
        "control-plane:service:view",
        // Reading a pipe answers a plain `FORBIDDEN` without it (live): no
        // narrower ClickPipes permission exists.
        "control-plane:service:manage-clickpipes",
      ]);
      const clickPipeId = yield* target.clickPipeId;
      return () =>
        run((ids) =>
          Effect.flatMap(clickPipeId, (id) =>
            pipes
              .getClickPipe({ ...ids, clickPipeId: id })
              .pipe(Effect.flatMap(requireResult("getClickPipe"))),
          ),
        );
    });
  }),
);
