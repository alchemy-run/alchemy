import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Gateway } from "./Gateway.ts";

/**
 * Runtime binding for VPN `getGateway`: read a gateway's settings and state.
 *
 * Bind this operation to a {@link Gateway} in a Function/Worker init phase and provide
 * {@link GetGatewayHttp}. The gateway's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding only `vpn.gateway.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Gateway
 * **Example:** Read the gateway from a Cloudflare Worker
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
 *     const getGateway = yield* Stackit.VPN.GetGateway(yield* Office);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const gateway = yield* getGateway();
 *         return yield* HttpServerResponse.json({ state: gateway.state, plan: gateway.planId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetGatewayHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface GetGateway extends Binding.Service<
  GetGateway,
  "Stackit.VPN.GetGateway",
  (
    gateway: Gateway,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.GetGatewayResponse, vpn.GetGatewayError, RuntimeContext>
  >
> {}

export const GetGateway = Binding.Service<GetGateway>("Stackit.VPN.GetGateway");
