import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

/**
 * Runtime binding for VPN `listQuotas`: read how many gateways a project may have and how
 * many it uses.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope})
 * in a Function/Worker init phase and provide {@link ListQuotasHttp}. The project and
 * region are injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.quota.get` on the project of the bound resource,
 * the narrowest scope STACKIT binds roles on, so it reaches every object of this kind in
 * the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Quota
 * **Example:** Report remaining capacity from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Office = Stackit.VPN.Gateway("Office", {
 *   planId: "p100",
 *   routingType: "POLICY_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listQuotas = yield* Stackit.VPN.ListQuotas(yield* Office);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { quotas } = yield* listQuotas();
 *         return yield* HttpServerResponse.json({
 *           remaining: quotas.gateways.limit - quotas.gateways.usage,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.ListQuotasHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface ListQuotas extends Binding.Service<
  ListQuotas,
  "Stackit.VPN.ListQuotas",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.QuotaListResponse, vpn.ListQuotasError, RuntimeContext>
  >
> {}

export const ListQuotas = Binding.Service<ListQuotas>("Stackit.VPN.ListQuotas");
