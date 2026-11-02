import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Gateway } from "./Gateway.ts";

/**
 * Runtime binding for VPN `getGatewayStatus`: read a gateway's health: its state and error
 * message, each tunnel's public IP and BGP peers and routes, and the state of each
 * connection.
 *
 * Bind this operation to a {@link Gateway} in a Function/Worker init phase and provide
 * {@link GetGatewayStatusHttp}. The gateway's project, region and id are injected into
 * each request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.gateway.status.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Status
 * **Example:** Report BGP sessions from a Cloudflare Worker
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
 *     const getStatus = yield* Stackit.VPN.GetGatewayStatus(yield* Office);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const status = yield* getStatus();
 *         return yield* HttpServerResponse.json({
 *           state: status.gatewayStatus,
 *           peers: (status.tunnels ?? []).flatMap((tunnel) => tunnel.bgpStatus?.peers ?? []),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetGatewayStatusHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface GetGatewayStatus extends Binding.Service<
  GetGatewayStatus,
  "Stackit.VPN.GetGatewayStatus",
  (
    gateway: Gateway,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.GatewayStatusResponse, vpn.GetGatewayStatusError, RuntimeContext>
  >
> {}

export const GetGatewayStatus = Binding.Service<GetGatewayStatus>("Stackit.VPN.GetGatewayStatus");
