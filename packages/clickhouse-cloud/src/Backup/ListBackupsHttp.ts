import * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { Service } from "../Service/Service.ts";
import { ListBackups } from "./ListBackups.ts";

/** {@link ListBackups} over the ClickHouse Cloud API; works on any host. */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("ListBackups", target, [
        "control-plane:service:view",
        "control-plane:service:view-backups",
      ]);
      return () => run((ids) => backup.listBackups(ids));
    });
  }),
);
