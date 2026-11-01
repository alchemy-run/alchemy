import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Connection } from "./Connection.ts";

/**
 * Runtime binding for VPN `getGatewayConnectionStatus`: read each tunnel's state and
 * traffic counters. A tunnel's `established` depends on the remote peer.
 *
 * Bind this operation to a {@link Connection} in a Function/Worker init phase and provide
 * {@link GetConnectionStatusHttp}. The connection's project, region, gateway and id are
 * injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.connection.status.get` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches every object
 * of this kind in the project. The deployer needs `iam.role.add` on that scope to define
 * the role.
 *
 * ### Reading the Status
 * **Example:** Report the tunnels that are up from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * const phase = {
 *   encryptionAlgorithms: ["aes256" as const],
 *   integrityAlgorithms: ["sha2_384" as const],
 *   dhGroups: ["ecp384" as const],
 * };
 *
 * export const Berlin = Stackit.VPN.Connection("Berlin", {
 *   gatewayId: "11111111-1111-4111-8111-111111111111",
 *   localSubnets: ["10.0.0.0/16"],
 *   remoteSubnets: ["192.168.0.0/24"],
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey: Redacted.make("a-key-of-at-least-20-characters"),
 *     phase1: phase,
 *     phase2: phase,
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey: Redacted.make("a-key-of-at-least-20-characters"),
 *     phase1: phase,
 *     phase2: phase,
 *   },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getStatus = yield* Stackit.VPN.GetConnectionStatus(yield* Berlin);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const status = yield* getStatus();
 *         return yield* HttpServerResponse.json({
 *           up: (status.tunnels ?? []).filter((tunnel) => tunnel.established).length,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetConnectionStatusHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface GetConnectionStatus extends Binding.Service<
  GetConnectionStatus,
  "Stackit.VPN.GetConnectionStatus",
  (
    connection: Connection,
  ) => Effect.Effect<
    () => Effect.Effect<
      vpn.ConnectionStatusResponse,
      vpn.GetGatewayConnectionStatusError,
      RuntimeContext
    >
  >
> {}

export const GetConnectionStatus = Binding.Service<GetConnectionStatus>(
  "Stackit.VPN.GetConnectionStatus",
);
