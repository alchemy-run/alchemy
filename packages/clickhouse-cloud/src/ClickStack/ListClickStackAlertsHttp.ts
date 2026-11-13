import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { Service } from "../Service/Service.ts";
import { ListClickStackAlerts, type ListClickStackAlertsRequest } from "./ListClickStackAlerts.ts";

/** {@link ListClickStackAlerts} over the ClickHouse Cloud API; works on any host. */
export const ListClickStackAlertsHttp = Layer.effect(
  ListClickStackAlerts,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("ListClickStackAlerts", target, [
        "control-plane:service:view",
        "control-plane:service:manage-clickstack-api",
      ]);
      return (request?: ListClickStackAlertsRequest) =>
        run((ids) => stack.listClickStackAlerts({ ...request, ...ids }));
    });
  }),
);
