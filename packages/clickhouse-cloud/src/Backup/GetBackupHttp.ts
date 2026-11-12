import * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { Service } from "../Service/Service.ts";
import { GetBackup } from "./GetBackup.ts";

/** {@link GetBackup} over the ClickHouse Cloud API; works on any host. */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetBackup", target, [
        "control-plane:service:view",
        "control-plane:service:view-backups",
      ]);
      return (backupId: string) =>
        run((ids) =>
          backup.getBackup({ ...ids, backupId }).pipe(Effect.flatMap(requireResult("getBackup"))),
        );
    });
  }),
);
