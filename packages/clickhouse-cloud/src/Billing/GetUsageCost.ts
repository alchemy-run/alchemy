import type * as billing from "@distilled.cloud/clickhouse-cloud/billing";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "../Organization/Organization.ts";

/** The window of a usage cost report. */
export interface GetUsageCostRequest {
  /** First day of the report, `YYYY-MM-DD`. */
  fromDate: string;
  /** Last day of the report (inclusive), `YYYY-MM-DD`, at most 30 days after `fromDate`. */
  toDate: string;
  /** Resource tag filters, e.g. `["tag:team=data"]`. */
  filter?: string[];
}

/**
 * Read the organization's usage cost at runtime: the grand total and the
 * daily cost of each data warehouse, service and ClickPipe in ClickHouse
 * Credits, for a window of up to 31 days. Records with `locked: false` can
 * still change. Use it for cost dashboards and budget alarms.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` and
 * `control-plane:organization:view-billing` on the organization. ClickHouse
 * Cloud federates no workload identity, so a key is the only way in.
 *
 * ### Reading Usage Cost
 * **Example:** What the organization spent today
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Costs extends Cloudflare.Worker<Costs>()(
 *   "Costs",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view and :view-billing
 *     const getUsageCost = yield* ClickHouseCloud.Billing.GetUsageCost(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const today = new Date().toISOString().slice(0, 10);
 *         // runtime
 *         const usage = yield* getUsageCost({ fromDate: today, toDate: today });
 *         return yield* HttpServerResponse.json({ total: usage.grandTotalCHC });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Billing.GetUsageCostHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Billing
 */
export interface GetUsageCost extends Binding.Service<
  GetUsageCost,
  "ClickHouseCloud.Billing.GetUsageCost",
  (
    target: Organization,
  ) => Effect.Effect<
    (
      request: GetUsageCostRequest,
    ) => Effect.Effect<billing.UsageCost, billing.GetUsageCostError, RuntimeContext>
  >
> {}

export const GetUsageCost = Binding.Service<GetUsageCost>("ClickHouseCloud.Billing.GetUsageCost");
