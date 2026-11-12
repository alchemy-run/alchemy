import * as notifications from "@distilled.cloud/clickhouse-cloud/notifications";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import type { Organization } from "../Organization/Organization.ts";
import { ListNotifications, type ListNotificationsRequest } from "./ListNotifications.ts";

/** {@link ListNotifications} over the ClickHouse Cloud API; works on any host. */
export const ListNotificationsHttp = Layer.effect(
  ListNotifications,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("ListNotifications", target, ["control-plane:organization:view"]);
      return (request?: ListNotificationsRequest) =>
        run((ids) =>
          notifications.listNotifications
            .items({
              ...ids,
              severity: request?.severity,
              type: request?.type,
              resource_id: request?.resourceId,
              resource_type: request?.resourceType,
              from_date: request?.fromDate,
              to_date: request?.toDate,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((items) => Array.from(items)),
            ),
        );
    });
  }),
);
