import type * as vpn from "@distilled.cloud/stackit/vpn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Connection } from "./Connection.ts";

/**
 * Runtime binding for VPN `getGatewayConnection`: read a connection's settings. The
 * response never holds a pre-shared key.
 *
 * Bind this operation to a {@link Connection} in a Function/Worker init phase and provide
 * {@link GetConnectionHttp}. The connection's project, region, gateway and id are injected
 * into each request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `vpn.connection.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches every object of this
 * kind in the project. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Connection
 * **Example:** Read the connection from a Cloudflare Worker
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
 *     const getConnection = yield* Stackit.VPN.GetConnection(yield* Berlin);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const connection = yield* getConnection();
 *         return yield* HttpServerResponse.json({ enabled: connection.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetConnectionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT VPN
 * @category VPN
 */
export interface GetConnection extends Binding.Service<
  GetConnection,
  "Stackit.VPN.GetConnection",
  (
    connection: Connection,
  ) => Effect.Effect<
    () => Effect.Effect<vpn.ConnectionResponseOutput, vpn.GetGatewayConnectionError, RuntimeContext>
  >
> {}

export const GetConnection = Binding.Service<GetConnection>("Stackit.VPN.GetConnection");
