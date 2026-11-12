import type * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Organization } from "./Organization.ts";

/** A quota's code. */
export type QuotaCode = organization.OrganizationQuotaQuotaCode | (string & {});

/**
 * Read one of the organization's quotas at runtime, with its limit and
 * current usage, by code (`services-per-organization`,
 * `replicas-per-warehouse`, `api-keys-per-organization`, …).
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` on the organization. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Checking a Quota
 * **Example:** Refuse to create a service when none are left
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Quotas extends Cloudflare.Worker<Quotas>()(
 *   "Quotas",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view on the organization
 *     const getQuota = yield* ClickHouseCloud.Organization.GetOrganizationQuota(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const quota = yield* getQuota("services-per-organization");
 *         return yield* HttpServerResponse.json({ left: quota.value - (quota.usage ?? 0) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Organization.GetOrganizationQuotaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Organization
 */
export interface GetOrganizationQuota extends Binding.Service<
  GetOrganizationQuota,
  "ClickHouseCloud.Organization.GetOrganizationQuota",
  (
    target: Organization,
  ) => Effect.Effect<
    (
      quotaCode: QuotaCode,
    ) => Effect.Effect<
      organization.OrganizationQuota,
      organization.GetOrganizationQuotaError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const GetOrganizationQuota = Binding.Service<GetOrganizationQuota>(
  "ClickHouseCloud.Organization.GetOrganizationQuota",
);
