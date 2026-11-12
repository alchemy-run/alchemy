import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../internal/Errors.ts";
import { GetOrganizationQuota, type QuotaCode } from "./GetOrganizationQuota.ts";
import type { Organization } from "./Organization.ts";

/** {@link GetOrganizationQuota} over the ClickHouse Cloud API; works on any host. */
export const GetOrganizationQuotaHttp = Layer.effect(
  GetOrganizationQuota,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("GetOrganizationQuota", target, ["control-plane:organization:view"]);
      return (quotaCode: QuotaCode) =>
        run((ids) =>
          organization
            .getOrganizationQuota({ ...ids, quotaCode })
            .pipe(Effect.flatMap(requireResult("getOrganizationQuota"))),
        );
    });
  }),
);
