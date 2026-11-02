import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Gateway } from "./Gateway.ts";

export interface ListConnectionsRequest extends Omit<
  vpn.ListGatewayConnectionsRequest,
  "projectId" | "region" | "gatewayId"
> {}

/**
 * Runtime binding for VPN `listGatewayConnections`: list a gateway's connections,
 * optionally filtered with `label_selector`.
 *
 * Bind this operation to a {@link Gateway} in a Function/Worker init phase and provide
 * {@link ListConnectionsHttp}. The gateway's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding only `vpn.connection.list` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing Connections
 * **Example:** List a gateway's connections from a Cloudflare Worker
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
 *     const listConnections = yield* Stackit.VPN.ListConnections(yield* Office);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { connections } = yield* listConnections();
 *         return yield* HttpServerResponse.json({
 *           names: connections.map((connection) => connection.displayName),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.ListConnectionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface ListConnections extends Binding.Service<
  ListConnections,
  "Stackit.VPN.ListConnections",
  (
    gateway: Gateway,
  ) => Effect.Effect<
    (
      request?: ListConnectionsRequest,
    ) => Effect.Effect<vpn.ConnectionListOutput, vpn.ListGatewayConnectionsError, RuntimeContext>
  >
> {}

export const ListConnections = Binding.Service<ListConnections>("Stackit.VPN.ListConnections");
