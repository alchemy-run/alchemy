import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BGPFilter } from "./BGPFilter.ts";

/**
 * Runtime binding for VPN `listGatewayBGPFilterRules`: list the rules of a BGP filter.
 *
 * Bind this operation to a {@link BGPFilter} in a Function/Worker init phase and provide
 * {@link ListBGPFilterRulesHttp}. The filter's project, region, gateway and id are
 * injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.bgpfilter.list` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing Rules
 * **Example:** List a filter's rules from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Inbound = Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: "11111111-1111-4111-8111-111111111111",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listRules = yield* Stackit.VPN.ListBGPFilterRules(yield* Inbound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rules } = yield* listRules();
 *         return yield* HttpServerResponse.json({ sequences: rules.map((rule) => rule.sequence) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.ListBGPFilterRulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface ListBGPFilterRules extends Binding.Service<
  ListBGPFilterRules,
  "Stackit.VPN.ListBGPFilterRules",
  (
    filter: BGPFilter,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.BGPFilterRuleList, vpn.ListGatewayBGPFilterRulesError, RuntimeContext>
  >
> {}

export const ListBGPFilterRules = Binding.Service<ListBGPFilterRules>(
  "Stackit.VPN.ListBGPFilterRules",
);
