import type * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Organization } from "./Organization.ts";

/**
 * List the organization's quotas at runtime, each with its limit and
 * current usage (services per organization, replicas per warehouse, API
 * keys, …). Poll it to refuse work before hitting a limit.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` on the organization. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Checking Quotas
 * **Example:** Report quotas close to their limit
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Quotas extends Cloudflare.Worker<Quotas>()(
 *   "Quotas",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view on the organization
 *     const listQuotas = yield* ClickHouseCloud.Organization.ListOrganizationQuotas(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const quotas = yield* listQuotas();
 *         const tight = quotas.filter((q) => (q.usage ?? 0) >= q.value * 0.8);
 *         return yield* HttpServerResponse.json(tight);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Organization.ListOrganizationQuotasHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Organization
 */
export interface ListOrganizationQuotas extends Binding.Service<
  ListOrganizationQuotas,
  "ClickHouseCloud.Organization.ListOrganizationQuotas",
  (
    target: Organization,
  ) => Effect.Effect<
    () => Effect.Effect<
      organization.OrganizationQuota[],
      organization.ListOrganizationQuotasError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const ListOrganizationQuotas = Binding.Service<ListOrganizationQuotas>(
  "ClickHouseCloud.Organization.ListOrganizationQuotas",
);
