import type * as billing from "@distilled.cloud/clickhouse-cloud/billing";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Organization } from "../Organization/Organization.ts";

/**
 * Read the organization's active credit balances at runtime: each prepaid
 * or trial balance with what remains of it, and `totalRemainingCredits`.
 * Use it to warn before credits run out. The endpoint is in public beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` and
 * `control-plane:organization:view-billing` on the organization. ClickHouse
 * Cloud federates no workload identity, so a key is the only way in.
 *
 * ### Reading Credit Balances
 * **Example:** Credits left
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Credits extends Cloudflare.Worker<Credits>()(
 *   "Credits",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view and :view-billing
 *     const getCreditBalances = yield* ClickHouseCloud.Billing.GetCreditBalances(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const credits = yield* getCreditBalances();
 *         return yield* HttpServerResponse.json({ left: credits.totalRemainingCredits });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Billing.GetCreditBalancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Billing
 */
export interface GetCreditBalances extends Binding.Service<
  GetCreditBalances,
  "ClickHouseCloud.Billing.GetCreditBalances",
  (
    target: Organization,
  ) => Effect.Effect<
    () => Effect.Effect<
      billing.CreditBalances,
      billing.GetCreditBalancesError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const GetCreditBalances = Binding.Service<GetCreditBalances>(
  "ClickHouseCloud.Billing.GetCreditBalances",
);
