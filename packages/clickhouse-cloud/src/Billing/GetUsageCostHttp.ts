import * as billing from "@distilled.cloud/clickhouse-cloud/billing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../Errors.ts";
import type { Organization } from "../Organization/Organization.ts";
import { GetUsageCost, type GetUsageCostRequest } from "./GetUsageCost.ts";

/** {@link GetUsageCost} over the ClickHouse Cloud API; works on any host. */
export const GetUsageCostHttp = Layer.effect(
  GetUsageCost,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("GetUsageCost", target, [
        "control-plane:organization:view",
        "control-plane:organization:view-billing",
      ]);
      return (request: GetUsageCostRequest) =>
        run((ids) =>
          billing
            .getUsageCost({
              ...ids,
              from_date: request.fromDate,
              to_date: request.toDate,
              filter: request.filter,
            })
            .pipe(Effect.flatMap(requireResult("getUsageCost"))),
        );
    });
  }),
);
