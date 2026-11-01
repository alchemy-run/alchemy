import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BGPFilter } from "./BGPFilter.ts";

/**
 * Runtime binding for VPN `getGatewayBGPFilter`: read a BGP filter.
 *
 * Bind this operation to a {@link BGPFilter} in a Function/Worker init phase and provide
 * {@link GetBGPFilterHttp}. The filter's project, region, gateway and id are injected into
 * each request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.bgpfilter.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Filter
 * **Example:** Read the filter from a Cloudflare Worker
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
 *     const getFilter = yield* Stackit.VPN.GetBGPFilter(yield* Inbound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const filter = yield* getFilter();
 *         return yield* HttpServerResponse.json({ name: filter.displayName });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetBGPFilterHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface GetBGPFilter extends Binding.Service<
  GetBGPFilter,
  "Stackit.VPN.GetBGPFilter",
  (
    filter: BGPFilter,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.BGPFilter, vpn.GetGatewayBGPFilterError, RuntimeContext>
  >
> {}

export const GetBGPFilter = Binding.Service<GetBGPFilter>("Stackit.VPN.GetBGPFilter");
