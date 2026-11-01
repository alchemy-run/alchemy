import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BGPFilterRule } from "./BGPFilterRule.ts";

/**
 * Runtime binding for VPN `getGatewayBGPFilterRule`: read one rule of a BGP filter.
 *
 * Bind this operation to a {@link BGPFilterRule} in a Function/Worker init phase and
 * provide {@link GetBGPFilterRuleHttp}. The rule's project, region, gateway, filter and id
 * are injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.bgpfilter.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Rule
 * **Example:** Read the rule from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const AllowOffice = Stackit.VPN.BGPFilterRule("AllowOffice", {
 *   gatewayId: "11111111-1111-4111-8111-111111111111",
 *   filterId: "22222222-2222-4222-8222-222222222222",
 *   sequence: 10,
 *   action: "PERMIT",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getRule = yield* Stackit.VPN.GetBGPFilterRule(yield* AllowOffice);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rule = yield* getRule();
 *         return yield* HttpServerResponse.json({ action: rule.action, sequence: rule.sequence });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetBGPFilterRuleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface GetBGPFilterRule extends Binding.Service<
  GetBGPFilterRule,
  "Stackit.VPN.GetBGPFilterRule",
  (
    rule: BGPFilterRule,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.BGPFilterRule, vpn.GetGatewayBGPFilterRuleError, RuntimeContext>
  >
> {}

export const GetBGPFilterRule = Binding.Service<GetBGPFilterRule>("Stackit.VPN.GetBGPFilterRule");
