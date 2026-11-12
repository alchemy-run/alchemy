import * as notifications from "@distilled.cloud/clickhouse-cloud/notifications";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { Organization } from "../Organization/Organization.ts";
import { ListNotificationTypes } from "./ListNotificationTypes.ts";

/** {@link ListNotificationTypes} over the ClickHouse Cloud API; works on any host. */
export const ListNotificationTypesHttp = Layer.effect(
  ListNotificationTypes,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("ListNotificationTypes", target, ["control-plane:organization:view"]);
      return () =>
        run((ids) =>
          notifications
            .listNotificationTypes(ids)
            .pipe(Effect.flatMap(requireResult("listNotificationTypes"))),
        );
    });
  }),
);
