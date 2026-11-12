import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../internal/Errors.ts";
import { ListActivities, type ListActivitiesRequest } from "./ListActivities.ts";
import type { Organization } from "./Organization.ts";

/** {@link ListActivities} over the ClickHouse Cloud API; works on any host. */
export const ListActivitiesHttp = Layer.effect(
  ListActivities,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("ListActivities", target, [
        "control-plane:organization:view",
        "control-plane:organization:view-activities",
      ]);
      return (request?: ListActivitiesRequest) =>
        run((ids) =>
          organization
            .listActivities({ ...request, ...ids })
            .pipe(Effect.flatMap(requireResult("listActivities"))),
        );
    });
  }),
);
