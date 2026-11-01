import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Connection } from "./Connection.ts";

export interface UpdateConnectionRequest extends Omit<
  vpn.UpdateGatewayConnectionRequest,
  "projectId" | "region" | "gatewayId" | "connectionId"
> {}

/**
 * Runtime binding for VPN `updateGatewayConnection`: change a connection from running
 * code, for failover or to switch it off through `enabled`.
 *
 * Bind this operation to a {@link Connection} in a Function/Worker init phase and provide
 * {@link UpdateConnectionHttp}. The connection's project, region, gateway and id are
 * injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * The update takes the whole connection, so send what a read returned plus your change. A
 * tunnel without `preSharedKey` keeps its key. Alchemy sees the change as drift only when
 * a later deploy updates this connection, and that deploy sets it back to the props.
 *
 * Access: a custom role holding only `vpn.connection.update` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Updating the Connection
 * **Example:** Switch the connection off from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
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
 *     const berlin = yield* Berlin;
 *     const getConnection = yield* Stackit.VPN.GetConnection(berlin);
 *     const updateConnection = yield* Stackit.VPN.UpdateConnection(berlin);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getConnection();
 *         const updated = yield* updateConnection({
 *           displayName: live.displayName,
 *           enabled: false,
 *           localSubnets: live.localSubnets,
 *           remoteSubnets: live.remoteSubnets,
 *           labels: live.labels,
 *           tunnel1: live.tunnel1,
 *           tunnel2: live.tunnel2,
 *         });
 *         return yield* HttpServerResponse.json({ enabled: updated.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Stackit.VPN.GetConnectionHttp, Stackit.VPN.UpdateConnectionHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface UpdateConnection extends Binding.Service<
  UpdateConnection,
  "Stackit.VPN.UpdateConnection",
  (
    connection: Connection,
  ) => Effect.Effect<
    (
      request: UpdateConnectionRequest,
    ) => Effect.Effect<
      vpn.ConnectionResponseOutput,
      vpn.UpdateGatewayConnectionError,
      RuntimeContext
    >
  >
> {}

export const UpdateConnection = Binding.Service<UpdateConnection>("Stackit.VPN.UpdateConnection");
