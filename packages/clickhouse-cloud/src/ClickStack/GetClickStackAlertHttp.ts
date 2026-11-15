import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { Alert } from "./Alert.ts";
import { GetClickStackAlert } from "./GetClickStackAlert.ts";

/** {@link GetClickStackAlert} over the ClickHouse Cloud API; works on any host. */
export const GetClickStackAlertHttp = Layer.effect(
  GetClickStackAlert,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Alert) {
      const run = yield* bind("GetClickStackAlert", target, [
        "control-plane:service:view",
        "control-plane:service:manage-clickstack-api",
      ]);
      const alertId = yield* target.id;
      return () =>
        run((ids) =>
          Effect.flatMap(alertId, (clickStackAlertId) =>
            stack.getClickStackAlert({ ...ids, clickStackAlertId }),
          ),
        );
    });
  }),
);
