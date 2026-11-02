import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListGatewaysRequest extends Omit<
  vpn.ListGatewaysRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for VPN `listGateways`: list the gateways in a project and region,
 * optionally filtered with `label_selector`.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope})
 * in a Function/Worker init phase and provide {@link ListGatewaysHttp}. The project and
 * region are injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.gateway.list` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing Gateways
 * **Example:** List gateways from a Cloudflare Worker
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
 *     const listGateways = yield* Stackit.VPN.ListGateways(yield* Office);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { gateways } = yield* listGateways();
 *         return yield* HttpServerResponse.json({ names: gateways.map((gateway) => gateway.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.ListGatewaysHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface ListGateways extends Binding.Service<
  ListGateways,
  "Stackit.VPN.ListGateways",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListGatewaysRequest,
    ) => Effect.Effect<vpn.GatewayList, vpn.ListGatewaysError, RuntimeContext>
  >
> {}

export const ListGateways = Binding.Service<ListGateways>("Stackit.VPN.ListGateways");
