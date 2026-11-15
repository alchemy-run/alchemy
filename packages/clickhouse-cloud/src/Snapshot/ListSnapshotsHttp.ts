import * as snapshot from "@distilled.cloud/clickhouse-cloud/snapshot";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { Service } from "../Service/Service.ts";
import { ListSnapshots } from "./ListSnapshots.ts";

/** {@link ListSnapshots} over the ClickHouse Cloud API; works on any host. */
export const ListSnapshotsHttp = Layer.effect(
  ListSnapshots,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("ListSnapshots", target, [
        "control-plane:service:view",
        "control-plane:service:view-snapshots",
      ]);
      return () =>
        run((ids) =>
          snapshot.listSnapshots.items(ids).pipe(
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        );
    });
  }),
);
