import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindOrganization } from "../ClickHouseCloudBindings.ts";
import { requireResult } from "../internal/Errors.ts";
import { ListOrganizationQuotas } from "./ListOrganizationQuotas.ts";
import type { Organization } from "./Organization.ts";

/** {@link ListOrganizationQuotas} over the ClickHouse Cloud API; works on any host. */
export const ListOrganizationQuotasHttp = Layer.effect(
  ListOrganizationQuotas,
  Effect.gen(function* () {
    const bind = yield* BindOrganization;
    return Effect.fn(function* (target: Organization) {
      const run = yield* bind("ListOrganizationQuotas", target, [
        "control-plane:organization:view",
      ]);
      return () =>
        run((ids) =>
          organization
            .listOrganizationQuotas(ids)
            .pipe(Effect.flatMap(requireResult("listOrganizationQuotas"))),
        );
    });
  }),
);
