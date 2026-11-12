import * as snapshot from "@distilled.cloud/clickhouse-cloud/snapshot";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { Service } from "../Service/Service.ts";
import { GetSnapshot } from "./GetSnapshot.ts";

/** {@link GetSnapshot} over the ClickHouse Cloud API; works on any host. */
export const GetSnapshotHttp = Layer.effect(
  GetSnapshot,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetSnapshot", target, [
        "control-plane:service:view",
        "control-plane:service:view-snapshots",
      ]);
      return (snapshotId: string) =>
        run((ids) =>
          snapshot
            .getSnapshot({ ...ids, snapshotId })
            .pipe(Effect.flatMap(requireResult("getSnapshot"))),
        );
    });
  }),
);
