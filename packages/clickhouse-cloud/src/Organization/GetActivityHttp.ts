import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../internal/Errors.ts";
import { GetActivity } from "./GetActivity.ts";
import type { Organization } from "./Organization.ts";

/** {@link GetActivity} over the ClickHouse Cloud API; works on any host. */
export const GetActivityHttp = Layer.effect(
  GetActivity,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("GetActivity", target, [
        "control-plane:organization:view",
        "control-plane:organization:view-activities",
      ]);
      return (activityId: string) =>
        run((ids) =>
          organization
            .getActivity({ ...ids, activityId })
            .pipe(Effect.flatMap(requireResult("getActivity"))),
        );
    });
  }),
);
